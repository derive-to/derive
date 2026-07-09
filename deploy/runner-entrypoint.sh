#!/bin/sh
# GH_TOKEN → git credential helper, so private repo pointers clone at boot.
# No-op without the token; failure is non-fatal (public pointers still work,
# and doctor's ls-remote probe reports exactly which pointer can't auth).
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
fi
exec derive runner "$@"
