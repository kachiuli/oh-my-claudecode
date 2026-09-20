/** Minimal TOML key scanner used only to prevent redefining managed Codex tables. */
function whitespace(source, index) {
    while (/\s/.test(source[index] ?? ""))
        index++;
    return index;
}
function basicEscape(source, index) {
    const escape = source[index];
    const simple = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
    };
    if (escape in simple)
        return { value: simple[escape], next: index + 1 };
    if (escape !== "u" && escape !== "U")
        return null;
    const length = escape === "u" ? 4 : 8;
    const digits = source.slice(index + 1, index + 1 + length);
    if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(digits))
        return null;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
        return null;
    return { value: String.fromCodePoint(codePoint), next: index + 1 + length };
}
function quotedKey(source, start) {
    const quote = source[start];
    let value = "";
    for (let index = start + 1; index < source.length; index++) {
        const character = source[index];
        if (character === quote)
            return { value, next: index + 1 };
        if (quote === '"' && character === "\\") {
            const decoded = basicEscape(source, index + 1);
            if (!decoded)
                return null;
            value += decoded.value;
            index = decoded.next - 1;
        }
        else {
            value += character;
        }
    }
    return null;
}
function dottedKey(source, start = 0) {
    const segments = [];
    let index = whitespace(source, start);
    while (index < source.length) {
        let segment;
        if (source[index] === '"' || source[index] === "'") {
            segment = quotedKey(source, index);
        }
        else {
            const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
            segment = match
                ? { value: match[0], next: index + match[0].length }
                : null;
        }
        if (!segment)
            return null;
        segments.push(segment.value);
        index = whitespace(source, segment.next);
        if (source[index] !== ".")
            break;
        index = whitespace(source, index + 1);
    }
    return segments.length ? { segments, next: index } : null;
}
function codeLine(line, multiline) {
    if (multiline.quote) {
        const end = line.indexOf(multiline.quote);
        if (end >= 0)
            delete multiline.quote;
        return "";
    }
    let basic = false;
    let literal = false;
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        if (!basic &&
            !literal &&
            (line.startsWith('"""', index) || line.startsWith("'''", index))) {
            const quote = line.slice(index, index + 3);
            if (line.indexOf(quote, index + 3) < 0)
                multiline.quote = quote;
            return line.slice(0, index);
        }
        const character = line[index];
        if (!basic && !literal && character === "#")
            return line.slice(0, index);
        if (!literal && character === '"' && !escaped)
            basic = !basic;
        else if (!basic && character === "'")
            literal = !literal;
        escaped = basic && character === "\\" && !escaped;
        if (character !== "\\")
            escaped = false;
    }
    return line;
}
function startsWithPath(value, target) {
    return target.every((segment, index) => value[index] === segment);
}
/**
 * True when appending `[target.path]` would redefine a table or extend a parent
 * that was already assigned as a value/inline table.
 */
export function hasTomlTableInsertionConflict(source, target) {
    const parent = target.slice(0, -1);
    let current = [];
    const multiline = {};
    for (const rawLine of source.split(/\r?\n/)) {
        const line = codeLine(rawLine, multiline).trim();
        if (!line)
            continue;
        const arrayTable = line.startsWith("[[");
        if (line.startsWith("[")) {
            const opening = arrayTable ? 2 : 1;
            const closing = arrayTable ? "]]" : "]";
            if (!line.endsWith(closing))
                continue;
            const parsed = dottedKey(line.slice(opening, -closing.length));
            if (!parsed ||
                whitespace(line.slice(opening, -closing.length), parsed.next) !==
                    line.slice(opening, -closing.length).length)
                continue;
            current = parsed.segments;
            if (startsWithPath(current, target) ||
                (arrayTable &&
                    startsWithPath(current, parent) &&
                    current.length === parent.length))
                return true;
            continue;
        }
        const parsed = dottedKey(line);
        if (!parsed || line[whitespace(line, parsed.next)] !== "=")
            continue;
        const assigned = [...current, ...parsed.segments];
        if (startsWithPath(assigned, target) ||
            (assigned.length === parent.length && startsWithPath(assigned, parent))) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=codex-config.js.map