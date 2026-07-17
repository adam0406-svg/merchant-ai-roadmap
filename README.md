# From merchant problem to working AI

An interactive walkthrough of how I would tackle a merchant-support AI problem end to end, using one running example: a merchant calling in with "My terminal won't take payments."

Built as an independent application project for the Jr. AI Specialist (Voice AI) role at Flatpay. It is not affiliated with, endorsed by, or connected to Flatpay's systems. All system specifics are marked assumptions, intended to be validated against real data and operating procedures.

## What's here

- `index.html` - the six-phase method walkthrough (discover, define, design, validate, launch, improve), including an executable implementation of the decision model with 11 scripted scenarios and a logic-test panel
- `workflow.html` - the full workflow specification: signal map, diagnosis branches, permission model, 20 edge cases, test plan, metrics, assumptions register
- `css/`, `js/` - vanilla CSS and JavaScript, no frameworks, no build step; `js/sim.js` is the decision engine (client-side only, no backend, no LLM calls)
- Two PDF versions of the material for offline reading

## Run locally

Open `index.html` in a browser. No build, no dependencies.

## Author

Adam Grøfte Barfod · adam0406@gmail.com · [LinkedIn](https://www.linkedin.com/in/adambarfod/)

Designed and written by me; implemented with Claude Code as the coding assistant.
