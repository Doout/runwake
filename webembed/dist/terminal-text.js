/*
 * Render terminal output as plain text. Log records keep their original bytes;
 * this only computes the final screen content shown in the activity view.
 */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RunwakeTerminal = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const clamp = value => Math.max(0, Number.isFinite(value) ? value : 0);

  function render(value) {
    const lines = [[]];
    let row = 0;
    let column = 0;
    const input = String(value ?? "");

    const line = () => {
      while (lines.length <= row) lines.push([]);
      return lines[row];
    };
    const move = (rowDelta, columnDelta) => {
      row = clamp(row + rowDelta);
      column = clamp(column + columnDelta);
      line();
    };
    const write = character => {
      const current = line();
      while (current.length < column) current.push(" ");
      current[column] = character;
      column += 1;
    };
    const parameter = (values, index, fallback) => {
      const parsed = Number.parseInt(values[index], 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    for (let index = 0; index < input.length;) {
      const character = input[index];
      if (character === "\x1b") {
        const next = input[index + 1];
        if (next === "[") {
          const match = /^\x1b\[([?>!]?[0-9;:]*)([ -/]*)([@-~])/.exec(input.slice(index));
          if (!match) {
            index += 1;
            continue;
          }
          const values = match[1].replace(/^[?>!]/, "").split(";");
          const command = match[3];
          const count = parameter(values, 0, 1);
          if (command === "A") move(-count, 0);
          else if (command === "B" || command === "e") move(count, 0);
          else if (command === "C" || command === "a") move(0, count);
          else if (command === "D") move(0, -count);
          else if (command === "E") {
            move(count, 0);
            column = 0;
          } else if (command === "F") {
            move(-count, 0);
            column = 0;
          } else if (command === "G" || command === "`") column = count - 1;
          else if (command === "H" || command === "f") {
            row = parameter(values, 0, 1) - 1;
            column = parameter(values, 1, 1) - 1;
            line();
          } else if (command === "J") {
            const mode = Number.parseInt(values[0] || "0", 10);
            if (mode === 2 || mode === 3) {
              lines.splice(0, lines.length, []);
              row = 0;
              column = 0;
            } else if (mode === 0) {
              line().splice(column);
              lines.splice(row + 1);
            }
          } else if (command === "K") {
            const current = line();
            const mode = Number.parseInt(values[0] || "0", 10);
            if (mode === 0) current.splice(column);
            else if (mode === 1) {
              for (let cursor = 0; cursor <= column && cursor < current.length; cursor += 1) current[cursor] = " ";
            } else if (mode === 2) current.splice(0);
          } else if (command === "P") {
            line().splice(column, count);
          } else if (command === "X") {
            const current = line();
            for (let cursor = column; cursor < column + count && cursor < current.length; cursor += 1) current[cursor] = " ";
          }
          index += match[0].length;
          continue;
        }
        if (next === "]") {
          const end = input.indexOf("\x07", index + 2);
          const stringEnd = input.indexOf("\x1b\\", index + 2);
          if (end >= 0 && (stringEnd < 0 || end < stringEnd)) index = end + 1;
          else if (stringEnd >= 0) index = stringEnd + 2;
          else index = input.length;
          continue;
        }
        index += Math.min(2, input.length - index);
        continue;
      }
      if (character === "\b") {
        column = clamp(column - 1);
        index += 1;
        continue;
      }
      if (character === "\r") {
        column = 0;
        index += 1;
        continue;
      }
      if (character === "\n") {
        row += 1;
        column = 0;
        line();
        index += 1;
        continue;
      }
      if (character === "\t") {
        column = (Math.floor(column / 8) + 1) * 8;
        index += 1;
        continue;
      }
      const codePoint = input.codePointAt(index);
      const printable = String.fromCodePoint(codePoint);
      if (codePoint >= 0x20 && codePoint !== 0x7f) write(printable);
      index += printable.length;
    }

    return lines.map(current => current.join("").replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
  }

  return { render };
});
