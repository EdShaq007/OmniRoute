import assert from "node:assert/strict";
import test from "node:test";
import { computeUsageRowCost } from "../../src/lib/usage/analyticsPricing.ts";

test(
  "analytics pricing extraction retains provider fallback order and archive semantics",
  { timeout: 1000 },
  () => {
    const row = {
      provider: "fixture",
      model: "fixture-model",
      promptTokens: 100,
      completionTokens: 10,
      cacheReadTokens: 60,
    };
    const pricing = { marker: 7 };
    const calculate = (resolved: Record<string, unknown>, tokens: Record<string, number>) => {
      assert.equal(tokens.input, 100);
      assert.equal(tokens.cacheRead, 60);
      return Number(resolved.marker);
    };
    assert.equal(
      computeUsageRowCost(row, { fixture: { "fixture-model": pricing } }, {}, (m) => m, calculate),
      7
    );
    assert.equal(
      computeUsageRowCost(
        row,
        { alias: { "fixture-model": pricing } },
        { fixture: "alias" },
        (m) => m,
        calculate
      ),
      7
    );
    assert.equal(
      computeUsageRowCost(
        { ...row, provider: "shared" },
        { second: { "fixture-model": pricing } },
        { first: "shared", second: "shared" },
        (m) => m,
        calculate
      ),
      7
    );
    assert.equal(
      computeUsageRowCost(
        { ...row, provider: "fixture-cn" },
        { fixture: { "fixture-model": pricing } },
        {},
        (m) => m,
        calculate
      ),
      7
    );
    assert.equal(
      computeUsageRowCost({ ...row, isAggregated: 1, storedCost: 3 }, {}, {}, (m) => m, calculate),
      3
    );
    assert.equal(
      computeUsageRowCost(
        { ...row, isAggregated: 1, storedCost: 0 },
        { fixture: { "fixture-model": pricing } },
        {},
        (m) => m,
        calculate
      ),
      7
    );
    assert.equal(
      computeUsageRowCost(
        { ...row, model: "fixture-model:free" },
        { fixture: { "fixture-model": pricing } },
        {},
        (m) => m,
        calculate
      ),
      0
    );
  }
);
