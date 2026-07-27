#!/bin/sh
# GH_TOKEN → git credential helper, so private repo pointers clone at boot.
# No-op without the token; failure is non-fatal (public pointers still work,
# and doctor's ls-remote probe reports exactly which pointer can't auth).
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
fi

# ONE image, two lanes. A per-WORK capability token can only ever do one thing — execute the
# single item it names — so its presence IS the instruction: take the one-shot lane and exit,
# whatever CMD says. That is what lets a hosted substrate (a Cloudflare Container, a child
# process) boot this same image with nothing but env, while `serve` stays the default for an
# owner-operated daemon.
#
# BOTH kinds route here. `derive runner run` dispatches on the prefix itself (runOnce: dksess_
# serves one ask, dkrun_ executes one automation run), so the two only need to reach it. When
# this matched dkrun_ alone, a session token fell through to `serve` with a blank
# DERIVE_CONTEXT, failed config validation, and exited 1 — so on Cloudflare every hosted ask
# boot-looped: the container died instantly, the session stayed open, and the next tick booted
# another one. Forever, burning container minutes and starving the scan window.
case "$DERIVE_TOKEN" in
  dkrun_*|dksess_*) exec derive runner run ;;
esac

exec derive runner "$@"
