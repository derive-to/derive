// Data slots live in their OWN package (@derive/data-slots): the parser and the shapes are
// host-agnostic and dependency-free by design, so they can be read and implemented by
// anyone, not only by this server. See packages/data-slots/SPEC.md for the contract.
//
// This file is a RE-EXPORT, not a copy. Every consumer in the repo reaches slots through
// the @derive/core barrel, and one duplicated implementation is how a fix to one caller
// silently misses the other — the failure this codebase has now shipped three times
// (a delete path that missed a child table, an unfurl that lost its data on extraction,
// a raw route that rebuilt its headers and lost CORS). One copy, re-exported.
export * from "@derive/data-slots"
