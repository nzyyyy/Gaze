use serde::{Deserialize, Serialize};

use crate::error::{GazeError, GazeResult};
use crate::models::TextPosition;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionEncoding {
    Utf8,
    Utf16,
    Utf32,
}

impl PositionEncoding {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("utf-8") => Self::Utf8,
            Some("utf-32") => Self::Utf32,
            _ => Self::Utf16,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Debug, Clone)]
pub struct TextIndex {
    line_starts: Vec<usize>,
    len: usize,
}

impl TextIndex {
    pub fn new(text: &str) -> Self {
        let mut line_starts = vec![0];
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                line_starts.push(index + 1);
            }
        }
        Self {
            line_starts,
            len: text.len(),
        }
    }

    pub fn line_of(&self, byte_offset: usize) -> u32 {
        match self.line_starts.binary_search(&byte_offset.min(self.len)) {
            Ok(line) => line as u32,
            Err(line) => line.saturating_sub(1) as u32,
        }
    }

    fn line_bounds(&self, text: &str, line: u32) -> GazeResult<(usize, usize)> {
        let start = *self
            .line_starts
            .get(line as usize)
            .ok_or_else(|| GazeError::Message("LSP 返回了超出文件范围的行号。".to_string()))?;
        let end = self
            .line_starts
            .get(line as usize + 1)
            .map(|next| next.saturating_sub(1))
            .unwrap_or(self.len);
        let mut content_end = end;
        if content_end > start && text.as_bytes().get(content_end - 1) == Some(&b'\r') {
            content_end -= 1;
        }
        Ok((start, content_end))
    }

    pub fn lsp_to_byte(
        &self,
        text: &str,
        position: LspPosition,
        encoding: PositionEncoding,
    ) -> GazeResult<usize> {
        let (start, end) = self.line_bounds(text, position.line)?;
        let line = &text[start..end];
        let target = position.character as usize;
        let (byte_in_line, _) = match encoding {
            PositionEncoding::Utf8 => {
                let mut offset = target.min(line.len());
                while offset > 0 && !line.is_char_boundary(offset) {
                    offset -= 1;
                }
                (offset, 0)
            }
            PositionEncoding::Utf16 => {
                units_to_byte(line, target, |character| character.len_utf16())
            }
            PositionEncoding::Utf32 => units_to_byte(line, target, |_| 1),
        };
        Ok(start + byte_in_line)
    }

    pub fn byte_to_lsp(
        &self,
        text: &str,
        byte_offset: usize,
        encoding: PositionEncoding,
    ) -> GazeResult<LspPosition> {
        let offset = byte_offset.min(self.len);
        let line = self.line_of(offset);
        let (start, end) = self.line_bounds(text, line)?;
        let clamped = offset.clamp(start, end);
        let prefix = &text[start..clamped];
        let character = match encoding {
            PositionEncoding::Utf8 => prefix.len() as u32,
            PositionEncoding::Utf16 => prefix.encode_utf16().count() as u32,
            PositionEncoding::Utf32 => prefix.chars().count() as u32,
        };
        Ok(LspPosition { line, character })
    }

    pub fn lsp_to_utf16(
        &self,
        text: &str,
        position: LspPosition,
        encoding: PositionEncoding,
    ) -> GazeResult<TextPosition> {
        let offset = self.lsp_to_byte(text, position, encoding)?;
        Ok(self.byte_to_utf16(text, offset))
    }

    pub fn utf16_to_lsp(
        &self,
        text: &str,
        position: TextPosition,
        encoding: PositionEncoding,
    ) -> GazeResult<LspPosition> {
        let byte = self.utf16_to_byte(text, position)?;
        self.byte_to_lsp(text, byte, encoding)
    }

    pub fn byte_to_utf16(&self, text: &str, byte_offset: usize) -> TextPosition {
        let offset = byte_offset.min(self.len);
        let line = self.line_of(offset);
        let start = self.line_starts.get(line as usize).copied().unwrap_or(0);
        let prefix = &text[start..offset];
        TextPosition {
            line,
            character: prefix.encode_utf16().count() as u32,
        }
    }

    pub fn utf16_to_byte(&self, text: &str, position: TextPosition) -> GazeResult<usize> {
        self.lsp_to_byte(
            text,
            LspPosition {
                line: position.line,
                character: position.character,
            },
            PositionEncoding::Utf16,
        )
    }
}

fn units_to_byte(line: &str, target: usize, width: impl Fn(char) -> usize) -> (usize, usize) {
    let mut units = 0usize;
    for (byte_index, character) in line.char_indices() {
        let next = units + width(character);
        if next > target {
            return (byte_index, units);
        }
        units = next;
    }
    (line.len(), units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_utf16_and_utf8_across_emoji_and_crlf() {
        let text = "a😀b\r\n名字 = 1\n";
        let index = TextIndex::new(text);
        assert_eq!(
            index
                .lsp_to_utf16(
                    text,
                    LspPosition {
                        line: 0,
                        character: 3,
                    },
                    PositionEncoding::Utf16,
                )
                .unwrap(),
            TextPosition {
                line: 0,
                character: 3
            }
        );
        assert_eq!(
            index
                .lsp_to_utf16(
                    text,
                    LspPosition {
                        line: 0,
                        character: 5,
                    },
                    PositionEncoding::Utf8,
                )
                .unwrap(),
            TextPosition {
                line: 0,
                character: 3
            }
        );
        assert_eq!(
            index
                .lsp_to_utf16(
                    text,
                    LspPosition {
                        line: 1,
                        character: 1,
                    },
                    PositionEncoding::Utf16,
                )
                .unwrap(),
            TextPosition {
                line: 1,
                character: 1
            }
        );
    }

    #[test]
    fn converts_utf16_offset_back_to_lsp_encodings() {
        let text = "😀\n名字";
        let index = TextIndex::new(text);
        let position = TextPosition {
            line: 1,
            character: 1,
        };
        assert_eq!(
            index
                .utf16_to_lsp(text, position, PositionEncoding::Utf16)
                .unwrap(),
            LspPosition {
                line: 1,
                character: 1
            }
        );
        assert_eq!(
            index
                .utf16_to_lsp(text, position, PositionEncoding::Utf8)
                .unwrap(),
            LspPosition {
                line: 1,
                character: 3
            }
        );
        assert_eq!(
            index
                .utf16_to_lsp(text, position, PositionEncoding::Utf32)
                .unwrap(),
            LspPosition {
                line: 1,
                character: 1
            }
        );
    }

    #[test]
    fn clamps_out_of_range_positions_to_line_content() {
        let text = "abc\r\ndef";
        let index = TextIndex::new(text);
        assert_eq!(
            index
                .lsp_to_utf16(
                    text,
                    LspPosition {
                        line: 0,
                        character: 99
                    },
                    PositionEncoding::Utf16,
                )
                .unwrap(),
            TextPosition {
                line: 0,
                character: 3
            }
        );
    }
}
