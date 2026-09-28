import { test } from "node:test";
import assert from "node:assert/strict";
import { discount } from "../src/discount.js";

test("AC-01 10% off at 100 and above", () => {
  assert.equal(discount(100), 90);
  assert.equal(discount(250), 225);
});
test("AC-02 no discount below 100", () => {
  assert.equal(discount(99.99), 99.99);
});
test("AC-03 negative total is rejected", () => {
  assert.throws(() => discount(-1), RangeError);
});
