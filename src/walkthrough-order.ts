type Category = {
  label: string;
  re: RegExp;
};

const CATEGORIES: Category[] = [
  { label: "types/schema/constants", re: /\/(types?|schemas?|constants?|interfaces?|models?)(\/|\.)|types?\.(ts|js)$|schemas?\.(ts|js)$/i },
  { label: "domain/service/utils",   re: /\/(services?|domain|utils?|helpers?|lib)\//i },
  { label: "state/hooks/controllers",re: /\/(hooks?|store|state|contexts?|controllers?|reducers?|actions?)\//i },
  { label: "ui/pages/components",    re: /\/(pages?|components?|views?|screens?|ui)\//i },
  { label: "tests",                  re: /\.(test|spec)\.(ts|tsx|js|jsx)$|\/__(tests?|mocks?)__\//i },
  {
    label: "config/tooling",
    re: /(\/config\/|\/configs?\/|\/scripts?\/|^(vite|tsconfig|jest|eslint|rollup|webpack|babel|\.github)|Dockerfile[^/]*$|docker-compose|\.dockerignore$|azure-pipelines|\.ya?ml$|\.github\/|CHANGELOG|LICENSE)/i
  }
];

function getCategory(filePath: string): number {
  for (const [i, { re }] of CATEGORIES.entries()) {
    if (re.test(filePath)) return i;
  }
  return CATEGORIES.length; // unknown → after all known categories
}

export function buildWalkthroughOrder(filePaths: string[]): string[] {
  const originalIndex = new Map(filePaths.map((p, i) => [p, i]));
  return [...filePaths].sort((a, b) => {
    const ca = getCategory(a);
    const cb = getCategory(b);
    if (ca !== cb) return ca - cb;
    return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
  });
}
