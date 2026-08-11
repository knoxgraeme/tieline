import { value } from "./lib/value";
import { item } from "./directory";
import type { Model } from "@app/types";
import { through } from "./barrel";
import { uncertain } from "./ambiguous-barrel";
import { duplicate } from "./duplicates";
import { first, second } from "./same-symbol";
import external from "external-package";
import "./lib/explicit.js";
import "./multiple";
import "@app/generated";
import "#conditional";

const common = require("./common");
const lazy = import(runtimePath);
const staticLazy = import("./lazy");

export const result: Model = { value: value + item + through + uncertain + duplicate + first + second };
void common;
void lazy;
void staticLazy;
void external;
