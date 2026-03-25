type DirNode = { [key: string]: DirNode | null };

function insertPath(root: DirNode, parts: string[]): void {
  if (parts.length === 0) return;
  const [head, ...rest] = parts;
  if (!head) return;
  if (rest.length === 0) {
    root[head] = null; // leaf (file)
  } else {
    if (!(head in root) || root[head] === null) {
      root[head] = {};
    }
    insertPath(root[head] as DirNode, rest);
  }
}

function renderNode(node: DirNode, prefix: string): string[] {
  const entries = Object.entries(node);
  const lines: string[] = [];
  for (const [i, [name, child]] of entries.entries()) {
    const isLast = i === entries.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    if (child === null) {
      lines.push(`${prefix}${branch}${name}`);
    } else {
      lines.push(`${prefix}${branch}${name}/`);
      lines.push(...renderNode(child, prefix + childPrefix));
    }
  }
  return lines;
}

export function buildAsciiTree(filePaths: string[]): string {
  const root: DirNode = {};
  for (const p of filePaths) {
    insertPath(root, p.split("/"));
  }
  return renderNode(root, "").join("\n");
}
