# Notes for later

Items discovered during the final pass that are out of scope per the FINAL-PASS-BRIEF. Not for this build.

- **KYB demo link in the proof strip.** The strip names the AI KYB prototype but does not link it, per the brief's condition: only link once the URL is live and the repo name is neutral. Verify both, then add the link to the "Related work" cell in index.html.
- **og-image.png redesign.** The og:image URL is absolute and returns 200, but the PNG still shows the pre-final-pass design. Regenerating the 1200x630 image needs a browser render of the new hero; do this manually before sharing the link anywhere previews matter.
- **LinkedIn link check.** LinkedIn answers HEAD requests with 405 (bot blocking), so automated link checks always "fail" on it. The profile URL is correct; ignore the 405.
