const JAVA_FILE_REGEX = /\.java$/i;

export function isJavaPath(path) {
    if (typeof path !== "string") {
        return false;
    }
    return JAVA_FILE_REGEX.test(path);
}

function findMatchingBrace(source, openIndex) {
    if (typeof source !== "string" || !source.length) {
        return -1;
    }
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function buildLineIndex(source) {
    const starts = [0];
    if (typeof source !== "string" || !source.length) {
        return starts;
    }
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n") {
            starts.push(index + 1);
        }
    }
    return starts;
}

function lineNumberForIndex(lineStarts, index) {
    if (!Array.isArray(lineStarts) || !lineStarts.length) {
        return 1;
    }
    if (typeof index !== "number" || Number.isNaN(index) || index < 0) {
        return 1;
    }
    let low = 0;
    let high = lineStarts.length - 1;
    let line = 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const startIndex = lineStarts[mid];
        if (startIndex <= index) {
            line = mid + 1;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return line;
}

function cleanSignature(signature) {
    if (typeof signature !== "string") {
        return "";
    }
    return signature
        .replace(/\s+/g, " ")
        .replace(/\s*\(/g, "(")
        .trim();
}

function extractClasses(source) {
    if (typeof source !== "string" || !source.trim()) {
        return [];
    }
    const classes = [];
    const regex = /(class|interface|enum)\s+([A-Za-z_$][\w$]*)[^\{]*\{/g;
    let match;
    while ((match = regex.exec(source))) {
        const braceIndex = source.indexOf("{", match.index);
        if (braceIndex === -1) {
            continue;
        }
        const closingIndex = findMatchingBrace(source, braceIndex);
        if (closingIndex === -1) {
            continue;
        }
        classes.push({
            className: match[2],
            bodyStart: braceIndex + 1,
            bodyEnd: closingIndex
        });
        regex.lastIndex = closingIndex + 1;
    }
    return classes;
}

function extractMethodsFromClass(source, classInfo) {
    const methods = [];
    if (!classInfo || typeof classInfo.bodyStart !== "number" || typeof classInfo.bodyEnd !== "number") {
        return methods;
    }
    const classBody = source.slice(classInfo.bodyStart, classInfo.bodyEnd);
    const methodRegex = /(^|[\r\n])\s*(?:public|protected|private|static|final|native|synchronized|abstract|transient|volatile|strictfp|\s)+[\w<>\[\],\s]*?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws [^{]+)?\{/gm;
    let match;
    while ((match = methodRegex.exec(classBody))) {
        const signatureStart = match.index;
        const braceIndex = classBody.indexOf("{", match.index);
        if (braceIndex === -1) {
            continue;
        }
        const absoluteSignatureStart = classInfo.bodyStart + signatureStart;
        const absoluteBraceIndex = classInfo.bodyStart + braceIndex;
        const absoluteEndIndex = findMatchingBrace(source, absoluteBraceIndex);
        if (absoluteEndIndex === -1) {
            continue;
        }
        const block = source.slice(absoluteSignatureStart, absoluteEndIndex + 1).trim();
        if (!block) {
            continue;
        }
        methods.push({
            signature: cleanSignature(source.slice(absoluteSignatureStart, absoluteBraceIndex)),
            methodName: match[2] || "",
            block,
            startIndex: absoluteSignatureStart,
            endIndex: absoluteEndIndex
        });
        methodRegex.lastIndex = braceIndex + 1;
    }
    return methods;
}

export function extractJavaMethodSegments(source) {
    if (typeof source !== "string" || !source.trim()) {
        return [];
    }
    const classes = extractClasses(source);
    if (!classes.length) {
        return [];
    }
    const lineIndex = buildLineIndex(source);
    const segments = [];
    classes.forEach((classInfo) => {
        const classMethods = extractMethodsFromClass(source, classInfo);
        classMethods.forEach((method) => {
            const startLine = lineNumberForIndex(lineIndex, method.startIndex);
            const endLine = lineNumberForIndex(lineIndex, method.endIndex);
            segments.push({
                text: method.block,
                rawText: method.block,
                className: classInfo.className,
                methodName: method.methodName,
                methodSignature: method.signature,
                label: `${classInfo.className || "UnknownClass"}::${method.methodName || method.signature || "(anonymous)"}`,
                kind: "java_method",
                startLine,
                endLine
            });
        });
    });
    return segments;
}

export function buildJavaSegments(source) {
    const segments = extractJavaMethodSegments(source);
    return segments.map((segment, index) => ({
        ...segment,
        index: index + 1,
        total: segments.length
    }));
}

export default {
    isJavaPath,
    extractJavaMethodSegments,
    buildJavaSegments
};
