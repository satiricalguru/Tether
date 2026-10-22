# Agent safety model

Tether's agent clicks, types and navigates in your browser using a model
that runs on your own machine. Local models are smaller and easier to
mislead than frontier models, so safety is enforced by the harness, never
left to the model's judgement. This page is the complete list of what the
agent may do on its own, what it must ask you about, and what it will never
do.

## 1. Action tiers

Every action is classified **before** it runs (`src/agent/tiers.ts`):

| Tier | Actions | What happens |
|---|---|---|
| **Read** | read the page, scroll, extract data, wait for content, hover | Runs automatically. |
| **Navigate** | open URLs, back/forward/reload, open/switch/close tabs, follow links, ordinary buttons | Runs automatically, inside the domain policy (§2). |
| **Write** | type, select, tick a checkbox, set a value, press a key | Runs automatically, except in credential fields (§3). |
| **Irreversible** | submitting a form (submit buttons, "type and submit", Enter in a form field); buttons named buy, purchase, pay, place order, delete, remove account/user/member, send, submit, confirm, transfer, (un)subscribe, post, publish, reply, donate, book, reserve, sign up/out, deactivate, close account; downloads | **Stops and asks you.** The panel shows the exact element, its label and context, and the page. Nothing happens until you choose **Allow once** or **Don't allow**. |

Approval is per action. Allowing one "Place order" doesn't allow the next.
If you don't allow an action, the agent is told so and asked to finish or
check with you. If it tries the same thing anyway, it's refused without
asking you again. Time spent waiting
for your answer doesn't count against the run's time limit.

## 2. Where the agent may go

Navigation (`src/agent/guard.ts`) is limited to `http(s)` pages. These are
**blocked by default**:

- banking (major banks by domain, plus `*banking.*` hosts and the `.bank` TLD)
- payment services and exchanges (PayPal, Stripe, Venmo, Wise, Coinbase…)
- government sites (`.gov`, `.mil`, `gov.uk`, `gc.ca`, `gouv.fr` …)
- webmail (Gmail, Outlook, Yahoo, Proton…)

You can allow a specific site under *Settings → Agent → Always allow*. The
settings page warns when you allow a default-blocked one. Your *Never visit*
list always wins.

**Navigation can leak data.** A malicious page might tell the agent to open
`https://evil.example/?d=<text it read elsewhere>`. Before any navigation,
Tether checks whether the URL's path or query carries a run of text the
agent saw in the task or on pages from *other* sites. If it does, the
navigation is refused.

## 3. What the agent never does

- **Credentials.** It never types into password, one-time-code or payment
  fields: `type=password`, `autocomplete` of `current-password`,
  `new-password`, `one-time-code` or `cc-*`, and fields labelled password,
  PIN, OTP, CVV, card number, IBAN or SSN. It also never types text that
  looks like a card number, SSN or API key, whatever the field. Login
  pages end with the agent asking you to sign in. These checks happen twice,
  in the background guard and again in the page engine.
- **CAPTCHAs and bot checks.** When one appears, the run stops and asks you
  to complete it.
- **Account creation, financial transfers, trades.** These fall under the
  irreversible tier at least, and the default domain blocks cover the usual
  places.

## 4. Pages are data, not instructions

- **Hidden text is never read.** Text styled invisible (display, visibility,
  opacity, tiny font, off-screen, clipped, same colour as its background) is
  dropped before the model sees the page. Hidden text that looks like an
  instruction is flagged.
- **Everything taken from a page is fenced** as
  `<untrusted_page_content>`: text, element names, link labels. The system
  prompt tells the model to report instructions found there, not follow
  them.
- **Visible injection attempts** ("ignore previous instructions", "as an
  AI you must…", fake system tags) are flagged with ⚠ in the panel.

## 5. Stopping

- **Stop** in the panel, or **Esc** with the panel focused.
- **The banner** shown on every tab the agent controls ("Tether is
  controlling this tab"): its **Stop** button, or **Esc** on that page. The
  banner lives in a closed shadow root and responds only to real input, so
  the page can't hide it or press it.
- **Budgets** end runs automatically: maximum steps (default 15), time
  (5 min), consecutive failures (3). **Loop detection** warns the model after
  the same action on the same element three times, and stops the run at
  five.

## 6. The record

Every step goes to a local trace: action, element, page, outcome, and a
hash of the page before and after (showing whether anything changed). Card
numbers, SSN-like numbers and token-like strings are redacted first. You can
review and export it under *Settings → Agent runs*. Nothing leaves your
machine.

## 7. Trusted input (optional)

By default the agent acts through scripted DOM events. Some sites only
accept "trusted" events, so *Settings → Agent* can switch to the **debugger**
backend, which sends real input through Chrome's DevTools protocol. It needs
the optional `debugger` permission. While it's in use, Chrome shows its own
"started debugging this browser" bar, and cancelling that bar also stops
trusted input. All the rules above apply unchanged.

## 8. Known limits

- Removing an item from a cart or list isn't treated as irreversible,
  because it's easy to undo. Deleting is.
- The irreversible-action list is pattern-based. A button labelled
  ambiguously ("Continue") that actually submits a payment is caught only if
  it is a form submit. When in doubt, keep sensitive sites on the blocked
  list.
- The exfiltration check catches text copied in runs of six words or more,
  not paraphrased or encoded data.
- Cross-origin iframes can't be read or operated by the agent.
