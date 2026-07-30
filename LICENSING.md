# Licensing at Derive

Derive is fair source. The code is public, you can self-host the whole product, and you can read every line before you trust it with your work. This page is the plain-English version of [the license](LICENSE): what you can do, the one thing you can't, and why we set it up this way.

The license is the [Functional Source License](https://fsl.software) (FSL-1.1-ALv2). We didn't write it, Sentry did. We adopted it because it already says exactly what we mean.

## What you can do

Almost everything.

Run Derive on your own infrastructure, for work, at any scale, free. The container you self-host is the same product we host. There's no enterprise edition, no license key, and nothing phones home (we can't see your instance, and we don't want to).

Modify it however you like. Fork it, patch it, rip out the parts you don't need.

Deploy it for clients. If you're an agency or consultancy standing up Derive for a customer, the license explicitly allows that as professional services.

Redistribute it. Share copies or your fork, just keep the license and copyright notices intact. That's the only paperwork. (The one thing that doesn't travel with a fork is the Derive name and logo. Trademarks stay ours, standard stuff.)

And the license carries an explicit patent grant, which is more than plain MIT gives you.

## The one thing you can't do

You can't sell Derive as Derive. Don't take the code and launch a competing hosted-Derive service. That's the whole restriction.

The reason is boring and honest: we fund the development. If someone could resell our own code against us on day one, there'd be no company left to keep building it.

If your use isn't "selling Derive to other people", you're fine. Not sure? Email hello@derive.to and we'll give you a straight answer.

## Every release becomes Apache-2.0 after two years

This part is written into the license and it's irrevocable. Each release converts to [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) two years after it ships, on a rolling clock (today's release converts two years from today, next month's two years from next month).

It doesn't depend on us behaving well, or on us existing at all. If Derive Labs vanished tomorrow, the conversion still happens on schedule and the community gets the whole codebase under a standard permissive license, competing uses included.

## Is this open source?

Strictly speaking, no. The FSL isn't an OSI-approved license because of the two-year window on competing commercial use, so we say fair source instead. We'd rather use the accurate term and let the code speak for itself.

That said, look at what you can actually verify here: the code is public, self-hosting has feature parity, your data sits on your infrastructure under your URLs, and the whole codebase turns genuinely open source on a fixed schedule. We think that beats a permissive license wrapped around a hollowed-out core.

## Why not MIT or Apache from day one?

Because we've watched how that story ends for infrastructure companies. A cloud vendor resells the product, contributes nothing back, and the company relicenses in a panic a few years in. Redis, Elastic, and Terraform all took that road, and the relicensing surprise is what actually burned people.

We'd rather state the deal up front: everything's free except competing with us, and everything becomes Apache-2.0 in two years. There's no surprise left for us to spring, the grant is already made.

## Why not AGPL?

The AGPL is real open source and we respect the projects that use it. In practice, though, it scares your users more than your competitors. Plenty of legal departments ban AGPL software outright, and that punishes exactly the teams we want self-hosting Derive.

Armin Ronacher's [FSL vs AGPL piece](https://lucumr.pocoo.org/2024/9/23/fsl-agpl-open-source-businesses/) makes the full case better than we can. The short version: under the FSL, internal use carries no copyleft obligations at all, so there's nothing for your legal team to read twice.

## Contributions

Inbound = outbound. Contributions are licensed the same way as the project, future Apache-2.0 grant included. The practical workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Questions

If anything here is unclear, email hello@derive.to. We'd rather answer a question than have you guess.
