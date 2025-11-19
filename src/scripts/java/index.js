const COMMENT_BLOCK_REGEX = /\/\*[\s\S]*?\*\//g;
const COMMENT_LINE_REGEX = /(^|[^:])\/\/.*$/gm;
const PACKAGE_REGEX = /^\s*package\s+[^;]+;\s*$/gim;
const IMPORT_REGEX = /^\s*import\s+[^;]+;\s*$/gim;

/**
 * Remove Java comments (both block and line) from source text.
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source = "") {
    if (!source) return "";
    const withoutBlock = source.replace(COMMENT_BLOCK_REGEX, "");
    return withoutBlock.replace(COMMENT_LINE_REGEX, "");
}

/**
 * Remove package and import declarations from Java source.
 * @param {string} source
 * @returns {string}
 */
export function stripPackageAndImports(source = "") {
    if (!source) return "";
    return source.replace(PACKAGE_REGEX, "").replace(IMPORT_REGEX, "");
}

function findMatchingBrace(text, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < text.length; index += 1) {
        const char = text[index];
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

function extractClassBodies(cleanedSource) {
    const classes = [];
    const classRegex = /class\s+([A-Za-z_$][\w$]*)[^\{]*\{/g;
    let match;
    while ((match = classRegex.exec(cleanedSource))) {
        const className = match[1];
        const braceIndex = cleanedSource.indexOf("{", match.index);
        const closingIndex = findMatchingBrace(cleanedSource, braceIndex);
        if (braceIndex === -1 || closingIndex === -1) continue;
        const body = cleanedSource.slice(braceIndex + 1, closingIndex);
        classes.push({
            className,
            start: braceIndex + 1,
            end: closingIndex,
            body
        });
        classRegex.lastIndex = closingIndex + 1;
    }
    return classes;
}

function extractMethodsFromClassBody(classBody) {
    const methods = [];
    const methodRegex = /(^|\n)\s*(?:public|protected|private|static|final|native|synchronized|abstract|transient|volatile|strictfp|\s)+[\w<>\[\],\s]*?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws [^{]+)?\{/gm;
    let match;
    while ((match = methodRegex.exec(classBody))) {
        const braceIndex = classBody.indexOf("{", match.index);
        if (braceIndex === -1) continue;
        const closingIndex = findMatchingBrace(classBody, braceIndex);
        if (closingIndex === -1) continue;

        const signature = classBody.slice(match.index, braceIndex).trim();
        const block = classBody.slice(match.index, closingIndex + 1).trim();
        methods.push({ signature, block });
        methodRegex.lastIndex = closingIndex + 1;
    }
    return methods;
}

/**
 * Process Java source by removing comments/package/import and splitting into method blocks.
 * @param {Object} options
 * @param {string} options.source - Raw Java source content.
 * @param {string} [options.path] - Optional path used for logging.
 * @returns {{ cleanedSource: string, classMethods: Array<{ className: string, methods: Array<{ signature: string, block: string }> }> }}
 */
export function processJavaFile({ source = "", path = "" } = {}) {
    const cleanedSource = stripPackageAndImports(stripComments(source)).trim();
    const classBodies = extractClassBodies(cleanedSource);
    const classMethods = classBodies.map((entry) => {
        const methods = extractMethodsFromClassBody(entry.body);
        return {
            className: entry.className,
            methods
        };
    });

    const label = path || "Java file";
    classMethods.forEach(({ className, methods }) => {
        if (!methods.length) return;
        methods.forEach(({ block }) => {
            console.log(`[Java Processor] ${label} -> ${className}:`, "\n" + block);
        });
    });

    return { cleanedSource, classMethods };
}

export default processJavaFile;
