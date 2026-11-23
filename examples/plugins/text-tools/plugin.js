globalThis.gazePlugin = (request) => {
  if (request.kind === "command") return { kind: "replace", text: request.text.toUpperCase() };

  const records = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = request.code.replace(/\r\n?/g, "\n") + "\n";
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"' && quoted && input[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (char === '"' && (quoted || cell === "")) {
      quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(cell);
      cell = "";
      if (char === "\n") {
        records.push(row);
        row = [];
      }
    } else {
      cell += char;
    }
  }

  const [headers, ...rows] = records;
  if (quoted || !headers || rows.some((record) => record.length !== headers.length)) {
    return { kind: "text", text: request.code };
  }
  return { kind: "table", headers, rows };
};
