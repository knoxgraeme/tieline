import DefaultThing, { named as renamed } from "./dependency.js";
export { shared } from "./shared.js";
export * from "./everything.js";

export function run(value) {
  return import("./lazy.js").then((module) => module.run(value));
}

export default class {
  execute() {
    return true;
  }
}

class First {
  same() {}
}

class Second {
  same() {}
}

function outer() {
  class Nested {
    go() {}
  }
  return Nested;
}

const configured = () => true;
let mutable = false;
