#!/bin/sh
# GH_TOKEN → git credential helper, so private repo pointers clone at boot.
# No-op without the token; failure is non-fatal (public pointers still work,
# and a clone that cannot authenticate says so in the job).
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
fi

# ONE image, two lanes. A job token (dkjob_) can only ever do one thing, run the one job it
# names, so its presence IS the instruction: take the one-shot lane and exit, whatever CMD says.
# Otherwise `runner serve --agent <id>` (or `once`) is the owner-operated daemon.
case "$DERIVE_TOKEN" in
  dkjob_*) exec derive runner run ;;
esac

exec derive runner "$@"
