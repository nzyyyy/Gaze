import { ensureSyntaxTree, type syntaxTree } from "@codemirror/language";
import { EditorSelection, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type SyntaxTree = ReturnType<typeof syntaxTree>;
type Node = SyntaxTree["topNode"];
const statementContainers = /^(Block|Body|ClassBody|InterfaceBody|EnumBody|DeclarationList)$/;
const classMembers =
  /^(MethodDeclaration|ConstructorDeclaration|FieldDeclaration|PropertyDeclaration)$/;

function isComment(node: Node) {
  return node.name === "Comment" || node.name === "LineComment" || node.name === "BlockComment";
}

function isStatement(node: Node) {
  return (
    node.type.is("Statement") || (node.parent?.name === "ClassBody" && classMembers.test(node.name))
  );
}

function statementAt(tree: SyntaxTree, doc: Text, position: number): Node | null {
  const line = doc.lineAt(position);
  const code = line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0);
  if (code === line.to) return null;
  const start = Math.max(code, position);
  for (
    let node: Node | null = tree.resolveInner(start, start === line.to ? -1 : 1);
    node;
    node = node.parent
  ) {
    if (isComment(node)) return start > code ? statementAt(tree, doc, code) : null;
    const parent = node.parent;
    if (isStatement(node) && parent && (parent.type.isTop || statementContainers.test(parent.name)))
      return node;
    if (statementContainers.test(node.name)) return null;
  }
  return null;
}

function statementLines(doc: Text, node: Node) {
  if (node.from === node.to) return null;
  let first = doc.lineAt(node.from);
  if (doc.sliceString(first.from, node.from).trim()) return null;
  let end = node.to;
  let last = doc.lineAt(end - 1);
  for (
    let next = node.nextSibling;
    next && isComment(next) && next.from <= last.to;
    next = next.nextSibling
  ) {
    end = next.to;
    last = doc.lineAt(end - 1);
  }
  if (end < last.to && doc.sliceString(end, last.to).trim()) return null;

  for (
    let previous = node.prevSibling;
    previous && isComment(previous);
    previous = previous.prevSibling
  ) {
    if (doc.lineAt(previous.to - 1).number !== first.number - 1) break;
    const comment = doc.lineAt(previous.from);
    if (doc.sliceString(comment.from, previous.from).trim()) break;
    first = comment;
  }
  return { from: first.from, to: last.to };
}

function hasSyntaxError(tree: SyntaxTree, from: number, to: number) {
  let error = false;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.type.isError) error = true;
      if (error) return false;
    },
  });
  return error;
}

export function moveStatement(view: EditorView, up: boolean) {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const {
    doc,
    selection: { main },
  } = state;
  const end = main.empty ? main.head : main.to - 1;
  const throughNextLine = (pos: number) =>
    doc.line(Math.min(doc.lines, doc.lineAt(pos).number + 1)).to;
  const tree = ensureSyntaxTree(state, throughNextLine(end), 20);
  if (!tree) return false;
  const first = statementAt(tree, doc, main.from);
  const last = statementAt(tree, doc, end);
  if (
    !first?.parent ||
    !last?.parent ||
    first.parent.from !== last.parent.from ||
    first.parent.to !== last.parent.to ||
    first.parent.type !== last.parent.type
  )
    return false;

  let neighbor = up ? first.prevSibling : last.nextSibling;
  while (neighbor && isComment(neighbor))
    neighbor = up ? neighbor.prevSibling : neighbor.nextSibling;
  if (!neighbor || !isStatement(neighbor)) return false;
  const firstLines = statementLines(doc, first);
  const lastLines = statementLines(doc, last);
  const neighborLines = statementLines(doc, neighbor);
  if (!firstLines || !lastLines || !neighborLines) return false;

  const moving = { from: firstLines.from, to: lastLines.to };
  const upper = up ? neighborLines : moving;
  const lower = up ? moving : neighborLines;
  if (
    upper.to >= lower.from ||
    lower.to > tree.length ||
    (tree.length < doc.length && lower.to === tree.length) ||
    hasSyntaxError(tree, upper.from, lower.to)
  )
    return false;

  const gap = doc.sliceString(upper.to, lower.from);
  const newUpperStart = upper.from + lower.to - lower.from + gap.length;
  const delta = up ? upper.from - lower.from : newUpperStart - upper.from;
  const movedPosition = (position: number) => Math.min(position, moving.to) + delta;
  const transaction = state.update({
    changes: {
      from: upper.from,
      to: lower.to,
      insert: doc.sliceString(lower.from, lower.to) + gap + doc.sliceString(upper.from, upper.to),
    },
    selection: EditorSelection.range(movedPosition(main.anchor), movedPosition(main.head)),
    scrollIntoView: true,
    userEvent: "move.statement",
  });

  // Reparse the moved region to catch statements that merge through an implicit terminator.
  const after = ensureSyntaxTree(transaction.state, throughNextLine(lower.to), 20);
  if (!after || hasSyntaxError(after, upper.from, lower.to)) return false;
  const stillStatement = (node: Node, lines: { from: number; to: number }, offset: number) => {
    const moved = statementAt(after, transaction.newDoc, node.from + offset);
    if (moved?.type !== node.type || moved.from !== node.from + offset) return false;
    const outline = statementLines(transaction.newDoc, moved);
    return outline?.from === lines.from + offset && outline.to === lines.to + offset;
  };
  if (
    !stillStatement(first, firstLines, delta) ||
    !stillStatement(last, lastLines, delta) ||
    !stillStatement(
      neighbor,
      neighborLines,
      up ? newUpperStart - upper.from : upper.from - lower.from,
    )
  )
    return false;
  view.dispatch(transaction);
  return true;
}
