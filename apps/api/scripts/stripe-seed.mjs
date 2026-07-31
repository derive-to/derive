#!/usr/bin/env node
// Idempotently create the Derive billing products + prices in whatever Stripe
// account STRIPE_SECRET_KEY points at (test or live). Safe to re-run: existing
// lookup keys are left alone.
//
//   STRIPE_SECRET_KEY=sk_test_... node apps/api/scripts/stripe-seed.mjs
import Stripe from "stripe"

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error("STRIPE_SECRET_KEY is required")
  process.exit(1)
}
const stripe = new Stripe(key)

const PLAN = [
  {
    product: "Derive Team",
    prices: [
      { lookup_key: "team_monthly", unit_amount: 1500, interval: "month" },
      { lookup_key: "team_annual", unit_amount: 14400, interval: "year" },
    ],
  },
  {
    product: "Derive Business",
    prices: [
      { lookup_key: "business_monthly", unit_amount: 3000, interval: "month" },
      { lookup_key: "business_annual", unit_amount: 30000, interval: "year" },
    ],
  },
]

const existing = await stripe.prices.list({
  lookup_keys: PLAN.flatMap((p) => p.prices.map((x) => x.lookup_key)),
  limit: 10,
})
const have = new Set(existing.data.map((p) => p.lookup_key))

for (const plan of PLAN) {
  const missing = plan.prices.filter((p) => !have.has(p.lookup_key))
  if (!missing.length) {
    console.log(`${plan.product}: all prices exist`)
    continue
  }
  const product = await stripe.products.create({ name: plan.product })
  for (const p of missing) {
    await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: p.unit_amount,
      recurring: { interval: p.interval },
      lookup_key: p.lookup_key,
      transfer_lookup_key: true,
    })
    console.log(`created ${p.lookup_key} (${p.unit_amount} cents / ${p.interval})`)
  }
}
console.log("done")
