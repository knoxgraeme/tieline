export function gradePatch(patch, testCase) {
  const violations = [];

  for (const pattern of testCase.forbiddenPatchPatterns ?? []) {
    const expression = new RegExp(pattern.source, pattern.flags ?? "");
    if (expression.test(patch)) violations.push(pattern.id);
  }

  return {
    pass: violations.length === 0,
    violations,
  };
}
