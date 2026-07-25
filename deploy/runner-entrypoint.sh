#!/bin/sh
# GH_TOKEN → git credential helper, so private repo pointers clone at boot.
# No-op without the token; failure is non-fatal (public pointers still work,
# and doctor's ls-remote probe reports exactly which pointer can't auth).
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
fi

# ONE image, two lanes. A per-run capability token (dkrun_…) can only ever do one
# thing — execute its own automation run — so its presence IS the instruction: take
# the context-less run lane and exit, whatever CMD says. That is what lets a hosted
# substrate (a Cloudflare Container, a child process) boot this same image with
# nothing but env, while `serve` stays the default for an owner-operated daemon.
case "$DERIVE_TOKEN" in
  dkrun_*) exec derive runner run ;;
esac

exec derive runner "$@"
