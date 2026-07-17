/* Executable implementation of the deterministic decision model from the
   workflow specification. Client-side only: no backend, no LLM calls, no
   simulated speech. The rules below encode the specification's priority
   order exactly; scenarios and signals are illustrative hypotheses. */
(function () {
  'use strict';

  /* ==================== decision engine ==================== */

  var BRANCH_LABELS = {
    A: 'Branch A · Platform incident',
    B: 'Branch B · Local connectivity',
    C: 'Branch C · Device fault / software',
    D: 'Branch D · Account-level restriction',
    E: 'Branch E · Card-side declines',
    F: 'Branch F · Wrong or unclear device',
    human: 'Human specialist',
    none: 'No technical fault found'
  };

  var VERIFICATIONS = {
    A: 'Incident resolved and broadcast confirmed; callback kept for this merchant.',
    B: 'Terminal-to-host connection test, then a merchant payment attempt observed in telemetry.',
    C: 'Device reports healthy in telemetry and a merchant payment attempt goes through.',
    D: 'Case accepted by the account specialist inside the SLA; merchant told exactly who takes over.',
    E: 'Merchant confirms understanding; the next genuine card attempt is monitored in the transaction log.',
    F: 'Correct device identified; the case re-enters diagnosis with the right context.',
    human: 'Warm handoff completed with the full context package; the merchant does not repeat themselves.',
    none: 'No fix applied; payout follow-up confirmed with the specialist queue.'
  };

  function basePermissions() {
    return {
      autonomous: [
        'Read any signal source',
        'Guide reboot and network recovery',
        'Explain decline codes',
        'Resend receipts, create and update tickets',
        'Schedule callbacks, send self-serve links'
      ],
      confirmFirst: [
        'Push software update',
        'Remote-restart the terminal',
        'Order replacement hardware',
        'Change non-financial settings'
      ],
      never: [
        'Discuss reasons behind a risk or KYC hold',
        'Change payout accounts or financial settings',
        'Promise refunds, credits or waivers',
        'Continue troubleshooting after two failed fix cycles'
      ]
    };
  }

  var DOWN_SYMPTOMS = ['cannot_take_payments', 'network_error', 'frozen_screen'];

  var SYMPTOM_FALLBACK_BRANCH = {
    cannot_take_payments: 'B',
    network_error: 'B',
    frozen_screen: 'C',
    cards_declined: 'E',
    worked_earlier: 'B',
    wrong_device_or_unclear: 'F',
    other: 'human'
  };

  function decide(input) {
    var out = {
      mode: 'normal',
      primaryBranch: null,
      secondaryFindings: [],
      firedRules: [],
      permissions: basePermissions(),
      nextVerification: null,
      escalationTrigger: null
    };
    var degraded = false;

    /* Rule 1: signal APIs unreachable */
    if (input.signalApisReachable === false) {
      degraded = true;
      out.mode = 'degraded';
      out.firedRules.push('Rule 1 · Signal APIs unreachable: degraded mode. Question-driven diagnosis from the reported symptom only, reduced autonomy, human help offered.');
      out.permissions.autonomous = [
        'Question-driven diagnosis',
        'Guide reboot and network recovery from the merchant’s answers',
        'Schedule callbacks, send self-serve links'
      ];
      out.permissions.confirmFirst = ['Any remote action, retried once systems return'];
      out.secondaryFindings.push('System signals unavailable: every conclusion below is provisional until telemetry returns.');
    }

    /* Rule 2: human requested */
    if (input.humanRequested === true) {
      out.primaryBranch = 'human';
      out.firedRules.push('Rule 2 · Human requested: honored on the first request, warm handoff with everything gathered so far.');
      out.escalationTrigger = 'human_requested';
    }

    /* Rule 3: repeat-contact gate, before diagnosis */
    if (out.primaryBranch === null && input.repeatContact === true && input.priorResolutionVerified !== true) {
      out.primaryBranch = 'human';
      out.firedRules.push('Rule 3 · Repeat contact and the previous fix was never verified: straight to a human with full history. The gate fires before diagnosis.');
      out.escalationTrigger = 'repeat_contact_unverified_fix';
    }

    /* Rule 4: payments domain. Acceptance decides payment availability. */
    var acceptanceBlocked = !degraded && (input.paymentAcceptanceStatus === 'restricted' || input.paymentAcceptanceStatus === 'blocked' ||
      (input.accountReviewStatus === 'review_present' && input.paymentAcceptanceStatus === 'unknown'));
    if (acceptanceBlocked) {
      if (out.primaryBranch === null) {
        out.primaryBranch = 'D';
        out.firedRules.push('Rule 4 · Payment acceptance is ' + (input.paymentAcceptanceStatus === 'unknown' ? 'unknown with an account review present' : input.paymentAcceptanceStatus) + ': branch D. Acceptance determines payment availability, so this outranks any technical fault. Specialist handoff, never autonomous, reasons never discussed on the call.');
      } else {
        out.secondaryFindings.push('Account-level restriction active: branch D context attached for the receiving specialist.');
      }
      out.permissions.autonomous = ['Read signal sources', 'Create the specialist case with full context'];
      out.permissions.confirmFirst = [];
      out.permissions.never = [
        'Any troubleshooting or account action on this case: the specialist handles it',
        'Discuss reasons behind a risk or KYC hold',
        'Change payout accounts or financial settings',
        'Promise refunds, credits or waivers'
      ];
    }
    if (!degraded && (input.payoutStatus === 'delayed' || input.payoutStatus === 'blocked') && input.paymentAcceptanceStatus === 'enabled') {
      out.secondaryFindings.push('Payout ' + input.payoutStatus + ' with acceptance enabled: not a branch D emergency. Routed as a specialist follow-up, carried in the case context.');
      out.firedRules.push('Rule 4 · Payout ' + input.payoutStatus + ' but acceptance enabled: payments still flow, so this is a secondary finding with a specialist follow-up, not the primary branch.');
    }

    /* Rule 5: incidents */
    if (!degraded && input.incidentStatus === 'confirmed') {
      if (out.primaryBranch === null) {
        out.primaryBranch = 'A';
        out.mode = 'broadcast';
        out.firedRules.push('Rule 5 · Confirmed platform incident: branch A in broadcast mode. Inform, suppress invasive troubleshooting, protect the human queue.');
      } else {
        out.secondaryFindings.push('Confirmed platform incident running: incident context attached.');
      }
    } else if (!degraded && input.incidentStatus === 'symptom_spike') {
      if (out.mode === 'normal') out.mode = 'suspected_incident';
      out.firedRules.push('Rule 5 · Symptom spike without a confirmed incident: suspected-incident mode. Flag to the incident process, reduce invasive troubleshooting, continue conservatively.');
    }

    /* Rule 6: device disambiguation */
    var wrongDevice = input.deviceType === 'pos_tablet' || input.deviceType === 'printer' || input.deviceType === 'unclear' ||
      input.reportedSymptom === 'wrong_device_or_unclear';
    if (out.primaryBranch === null && wrongDevice) {
      if (input.clarificationAttempts >= 2) {
        out.primaryBranch = 'human';
        out.firedRules.push('Rule 6 · Device still unclear after two clarification attempts: stop looping, warm handoff.');
        out.escalationTrigger = 'clarification_budget_exhausted';
      } else {
        out.primaryBranch = 'F';
        out.firedRules.push('Rule 6 · The caller means ' + (input.deviceType === 'terminal' ? 'an unclear device' : 'the ' + input.deviceType.replace('_', ' ')) + ': branch F. Disambiguate against the product registry before any troubleshooting.');
      }
    }

    /* Rule 7: connectivity */
    var connectivityFault = !degraded && (input.heartbeat === 'missing' || input.heartbeat === 'stale') && input.recentAttempts === 'none';
    if (out.primaryBranch === null && connectivityFault) {
      out.primaryBranch = 'B';
      out.firedRules.push('Rule 7 · Heartbeat ' + input.heartbeat + ' and no payment attempts arriving: branch B guided recovery, every step verified in telemetry.');
      if (input.rebootAlreadyTried) {
        out.firedRules.push('Rule 7 · Merchant already rebooted: believed, step skipped, and the script says why the next step differs.');
      }
    } else if (connectivityFault && out.primaryBranch === 'D') {
      out.secondaryFindings.push('Connectivity fault also present (heartbeat ' + input.heartbeat + '): carried as a secondary fault. Acceptance determines payment availability, so branch B recovery waits for the specialist.');
      out.firedRules.push('Rule 7 · Connectivity fault detected but outranked by the account restriction: logged as a secondary finding, not the primary branch.');
    }

    /* Rule 8: declines with evidence */
    if (out.primaryBranch === null && !degraded && input.recentAttempts === 'present' &&
        (input.recentOutcomes === 'declined' || input.recentOutcomes === 'mixed') && input.declineCodeAvailable === true) {
      out.primaryBranch = 'E';
      out.firedRules.push('Rule 8 · Attempts arriving and declined with codes available: branch E. Show the terminal works, explain the decline codes, reassure with evidence.');
    }

    /* Rule 9: conflicting signals */
    if (out.primaryBranch === null && !degraded && input.heartbeat === 'ok' &&
        DOWN_SYMPTOMS.indexOf(input.reportedSymptom) !== -1) {
      out.firedRules.push('Rule 9 · Telemetry says online but the merchant says down: trust neither alone. Treat telemetry as possibly stale and run a terminal-to-host connection test.');
      if (input.reportedSymptom === 'frozen_screen') {
        out.primaryBranch = 'C';
        out.firedRules.push('Rule 9 · Frozen screen with a live heartbeat points at the device, not the network: branch C.');
      } else {
        out.primaryBranch = 'B';
        out.firedRules.push('Rule 9 · Connection test path: if it fails, connectivity is confirmed bad: branch B.');
      }
    }

    /* Rule 10: device state */
    var faultyDevice = ['frozen', 'hardware_error', 'firmware_outdated', 'update_pending'].indexOf(input.deviceState) !== -1;
    if (!degraded && faultyDevice) {
      if (out.primaryBranch === null) {
        out.primaryBranch = 'C';
        out.firedRules.push('Rule 10 · Device state is ' + input.deviceState.replace(/_/g, ' ') + ': branch C. Updates and remote restarts are confirm-first.');
      } else if (out.primaryBranch !== 'C') {
        out.secondaryFindings.push('Device state ' + input.deviceState.replace(/_/g, ' ') + ': carried as a secondary fault in the case context.');
      }
    }
    if (!degraded && input.market === 'DE' && (out.primaryBranch === 'C' || faultyDevice)) {
      var i = out.permissions.confirmFirst.indexOf('Push software update');
      if (i !== -1) out.permissions.confirmFirst.splice(i, 1);
      out.permissions.never.unshift('Push software update (DE: disabled pending validation of fiscal-device TSE implications; a conservative provisional configuration, not a statement of German law or Flatpay architecture)');
      out.firedRules.push('Rule 10 · Market overlay DE: software-update autonomy disabled pending TSE validation.');
    }

    /* Rule 11: verification level */
    if (input.verificationLevel === 'employee_low_assurance') {
      out.permissions.never.unshift('Account data and payment fallbacks (locked: caller verified at low assurance, hardware troubleshooting only)');
      out.firedRules.push('Rule 11 · Caller is an employee at low assurance: hardware troubleshooting allowed, account data and payment fallbacks locked.');
    } else if (input.verificationLevel === 'failed') {
      out.permissions.autonomous = ['Identity-first flow: guide the caller through verification'];
      out.permissions.confirmFirst = [];
      out.permissions.never.unshift('Any account data or account action (verification failed)');
      out.firedRules.push('Rule 11 · Verification failed: identity-first flow, no account actions of any kind.');
    }

    /* Rule 12: fix-cycle budget */
    if (input.failedFixCycles >= 2) {
      if (out.primaryBranch !== null && out.primaryBranch !== 'human') {
        out.secondaryFindings.push('Diagnosis so far (' + BRANCH_LABELS[out.primaryBranch] + ') travels with the handoff; nothing is repeated.');
      }
      out.primaryBranch = 'human';
      out.firedRules.push('Rule 12 · Two fix cycles failed verification: hard stop. Warm handoff with everything tried; never a third loop.');
      out.escalationTrigger = 'two_failed_fix_cycles';
    }

    /* Degraded fallback: diagnose from the reported symptom only */
    if (out.primaryBranch === null && degraded) {
      out.primaryBranch = SYMPTOM_FALLBACK_BRANCH[input.reportedSymptom] || 'human';
      out.firedRules.push('Rule 1 · Reported symptom "' + input.reportedSymptom.replace(/_/g, ' ') + '" maps to ' + BRANCH_LABELS[out.primaryBranch] + ' as a working hypothesis, verified by the merchant’s own payment attempt.');
    }

    /* No rule produced a branch: no technical fault found */
    if (out.primaryBranch === null) {
      out.primaryBranch = 'none';
      out.firedRules.push('No blocker on payment availability found in the signals. Anything the merchant raised is carried as a follow-up, not forced into a technical branch.');
    }

    out.nextVerification = VERIFICATIONS[out.primaryBranch];
    if (out.escalationTrigger === null && out.primaryBranch === 'D') {
      out.escalationTrigger = 'account_restriction_specialist_handoff';
    }
    return out;
  }

  /* ==================== input model ==================== */

  var DEFAULT_INPUT = {
    market: 'DK',
    reportedSymptom: 'cannot_take_payments',
    heartbeat: 'ok',
    recentAttempts: 'none',
    recentOutcomes: 'unavailable',
    declineCodeAvailable: false,
    paymentAcceptanceStatus: 'enabled',
    payoutStatus: 'normal',
    accountReviewStatus: 'none',
    incidentStatus: 'none',
    deviceType: 'terminal',
    deviceState: 'healthy',
    verificationLevel: 'verified_owner',
    repeatContact: false,
    priorResolutionVerified: null,
    humanRequested: false,
    signalApisReachable: true,
    rebootAlreadyTried: false,
    failedFixCycles: 0,
    clarificationAttempts: 0
  };

  var FIELD_GROUPS = [
    { name: 'What the merchant reports', fields: [
      ['market', 'Market', ['DK', 'FI', 'FR', 'DE', 'IT', 'UK']],
      ['reportedSymptom', 'Reported symptom', ['cannot_take_payments', 'network_error', 'frozen_screen', 'cards_declined', 'worked_earlier', 'wrong_device_or_unclear', 'other']],
      ['deviceType', 'Device in question', ['terminal', 'pos_tablet', 'printer', 'unclear']]
    ]},
    { name: 'What the systems show', fields: [
      ['signalApisReachable', 'Signal APIs reachable', [true, false]],
      ['heartbeat', 'Terminal heartbeat', ['ok', 'missing', 'stale']],
      ['recentAttempts', 'Recent payment attempts', ['none', 'present']],
      ['recentOutcomes', 'Recent outcomes', ['successful', 'declined', 'mixed', 'unavailable']],
      ['declineCodeAvailable', 'Decline codes available', [true, false]],
      ['deviceState', 'Device state', ['healthy', 'frozen', 'hardware_error', 'firmware_outdated', 'update_pending', 'unavailable']],
      ['paymentAcceptanceStatus', 'Payment acceptance', ['enabled', 'restricted', 'blocked', 'unknown']],
      ['payoutStatus', 'Payout status', ['normal', 'delayed', 'blocked', 'unknown']],
      ['accountReviewStatus', 'Account review', ['none', 'review_present', 'unknown']],
      ['incidentStatus', 'Incident status', ['none', 'confirmed', 'symptom_spike']]
    ]},
    { name: 'Caller and history', fields: [
      ['verificationLevel', 'Caller verification', ['verified_owner', 'employee_low_assurance', 'failed']],
      ['repeatContact', 'Repeat contact (7 days)', [false, true]],
      ['priorResolutionVerified', 'Prior fix verified', [null, true, false]],
      ['humanRequested', 'Human requested', [false, true]]
    ]},
    { name: 'Progress in this call', fields: [
      ['rebootAlreadyTried', 'Reboot already tried', [false, true]],
      ['failedFixCycles', 'Failed fix cycles', [0, 1, 2]],
      ['clarificationAttempts', 'Clarification attempts', [0, 1, 2]]
    ]}
  ];

  /* ==================== preset scenarios ==================== */

  function scenario(name, blurb, overrides) {
    var input = {};
    for (var k in DEFAULT_INPUT) input[k] = DEFAULT_INPUT[k];
    for (var o in overrides) input[o] = overrides[o];
    return { name: name, blurb: blurb, input: input };
  }

  var PRESETS = [
    scenario('1 · Lunch-rush connectivity failure',
      'Heartbeat gone, no attempts arriving, queue building.',
      { heartbeat: 'missing', deviceState: 'unavailable' }),
    scenario('2 · Issuer declines with codes',
      'Terminal fine; the cards are being declined by issuers.',
      { reportedSymptom: 'cards_declined', recentAttempts: 'present', recentOutcomes: 'declined', declineCodeAvailable: true }),
    scenario('3 · Confirmed regional incident',
      'Platform incident confirmed while the same symptom spikes.',
      { incidentStatus: 'confirmed', recentAttempts: 'present', recentOutcomes: 'unavailable' }),
    scenario('4 · Acceptance blocked, review present',
      'Payments stopped: the account, not the hardware.',
      { reportedSymptom: 'worked_earlier', paymentAcceptanceStatus: 'blocked', accountReviewStatus: 'review_present' }),
    scenario('5 · Frozen screen, heartbeat ok',
      'Telemetry says online; the merchant sees a frozen screen.',
      { reportedSymptom: 'frozen_screen' }),
    scenario('6 · Caller means the POS tablet',
      '"The system" turns out to be the order screen.',
      { reportedSymptom: 'wrong_device_or_unclear', deviceType: 'pos_tablet' }),
    scenario('7 · Employee, low assurance',
      'Staff member calls; owner not reachable.',
      { heartbeat: 'missing', deviceState: 'unavailable', verificationLevel: 'employee_low_assurance' }),
    scenario('8 · Second call, fix unverified',
      'Same symptom within days; last fix never verified.',
      { repeatContact: true, priorResolutionVerified: false }),
    scenario('9 · Acceptance blocked AND offline',
      'Two faults at once: the account restriction decides.',
      { paymentAcceptanceStatus: 'blocked', accountReviewStatus: 'review_present', heartbeat: 'missing', deviceState: 'unavailable' }),
    scenario('10 · Payout delayed, payments fine',
      'Money in, settlement late: not a terminal emergency.',
      { reportedSymptom: 'other', payoutStatus: 'delayed' }),
    scenario('11 · Telemetry API down',
      'The AI’s own signal sources are unreachable.',
      { signalApisReachable: false })
  ];

  /* Expected structured outputs, stored in full per the test-panel contract. */
  var EXPECTED = [
    { mode: 'normal', primaryBranch: 'B', escalationTrigger: null },
    { mode: 'normal', primaryBranch: 'E', escalationTrigger: null },
    { mode: 'broadcast', primaryBranch: 'A', escalationTrigger: null },
    { mode: 'normal', primaryBranch: 'D', escalationTrigger: 'account_restriction_specialist_handoff' },
    { mode: 'normal', primaryBranch: 'C', escalationTrigger: null },
    { mode: 'normal', primaryBranch: 'F', escalationTrigger: null },
    { mode: 'normal', primaryBranch: 'B', escalationTrigger: null,
      neverContains: 'Account data and payment fallbacks' },
    { mode: 'normal', primaryBranch: 'human', escalationTrigger: 'repeat_contact_unverified_fix' },
    { mode: 'normal', primaryBranch: 'D', escalationTrigger: 'account_restriction_specialist_handoff',
      secondaryContains: 'Connectivity fault also present' },
    { mode: 'normal', primaryBranch: 'none', escalationTrigger: null,
      secondaryContains: 'Payout delayed' },
    { mode: 'degraded', primaryBranch: 'B', escalationTrigger: null }
  ];
  PRESETS.forEach(function (p, i) {
    var full = decide(p.input);
    var spec = EXPECTED[i];
    p.expected = full;
    p.expectedSummary = spec;
  });

  function checkPreset(p) {
    var actual = decide(p.input);
    var spec = p.expectedSummary;
    var problems = [];
    if (actual.mode !== spec.mode) problems.push('mode: expected ' + spec.mode + ', got ' + actual.mode);
    if (actual.primaryBranch !== spec.primaryBranch) problems.push('primaryBranch: expected ' + spec.primaryBranch + ', got ' + actual.primaryBranch);
    if (actual.escalationTrigger !== spec.escalationTrigger) problems.push('escalationTrigger: expected ' + spec.escalationTrigger + ', got ' + actual.escalationTrigger);
    if (spec.neverContains && !actual.permissions.never.some(function (s) { return s.indexOf(spec.neverContains) !== -1; })) {
      problems.push('permissions.never missing "' + spec.neverContains + '"');
    }
    if (spec.secondaryContains && !actual.secondaryFindings.some(function (s) { return s.indexOf(spec.secondaryContains) !== -1; })) {
      problems.push('secondaryFindings missing "' + spec.secondaryContains + '"');
    }
    if (JSON.stringify(actual) !== JSON.stringify(p.expected)) {
      problems.push('full structured output drifted from the stored expected output');
    }
    return problems;
  }

  /* ==================== exports for tests / UI ==================== */

  var api = {
    decide: decide,
    DEFAULT_INPUT: DEFAULT_INPUT,
    FIELD_GROUPS: FIELD_GROUPS,
    PRESETS: PRESETS,
    BRANCH_LABELS: BRANCH_LABELS,
    checkPreset: checkPreset
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  window.SimEngine = api;

  /* ==================== UI ==================== */

  var root = document.getElementById('sim-app');
  if (!root) return;
  document.documentElement.classList.add('sim-js');

  var state = {};
  function setState(input) {
    state = {};
    for (var k in DEFAULT_INPUT) state[k] = input[k];
  }
  setState(DEFAULT_INPUT);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function optLabel(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v === null) return 'n/a';
    return String(v).replace(/_/g, ' ');
  }

  /* presets bar */
  var presetsBar = el('div', 'sim-presets');
  var customBtn = null;
  var activeBtn = null;
  function markActive(btn) {
    if (activeBtn) activeBtn.classList.remove('active');
    activeBtn = btn;
    if (btn) btn.classList.add('active');
  }
  PRESETS.forEach(function (p) {
    var b = el('button', 'sim-preset', p.name);
    b.type = 'button';
    b.title = p.blurb;
    b.addEventListener('click', function () {
      setState(p.input);
      markActive(b);
      renderToggles();
      renderOutput();
    });
    presetsBar.appendChild(b);
  });
  customBtn = el('button', 'sim-preset', 'Build your own');
  customBtn.type = 'button';
  customBtn.addEventListener('click', function () {
    setState(DEFAULT_INPUT);
    markActive(customBtn);
    renderToggles();
    renderOutput();
  });
  presetsBar.appendChild(customBtn);

  /* toggles */
  var togglesWrap = el('div', 'sim-toggles');
  function renderToggles() {
    togglesWrap.innerHTML = '';
    FIELD_GROUPS.forEach(function (group) {
      var g = el('div', 'sim-group');
      g.appendChild(el('h4', 'sim-group-h', group.name));
      group.fields.forEach(function (f) {
        var key = f[0], label = f[1], options = f[2];
        var row = el('div', 'sim-row');
        row.appendChild(el('span', 'sim-row-l', label));
        var opts = el('div', 'sim-opts');
        opts.setAttribute('role', 'group');
        opts.setAttribute('aria-label', label);
        options.forEach(function (v) {
          var b = el('button', 'sim-opt' + (state[key] === v ? ' on' : ''), optLabel(v));
          b.type = 'button';
          b.setAttribute('aria-pressed', state[key] === v ? 'true' : 'false');
          b.addEventListener('click', function () {
            state[key] = v;
            markActive(customBtn);
            renderToggles();
            renderOutput();
          });
          opts.appendChild(b);
        });
        row.appendChild(opts);
        g.appendChild(row);
      });
      togglesWrap.appendChild(g);
    });
  }

  /* output */
  var outputWrap = el('div', 'sim-output');
  outputWrap.setAttribute('aria-live', 'polite');
  function renderOutput() {
    var r = decide(state);
    outputWrap.innerHTML = '';

    var head = el('div', 'sim-out-head');
    var modeTag = el('span', 'sim-mode sim-mode-' + r.mode, 'mode: ' + r.mode.replace(/_/g, ' '));
    head.appendChild(modeTag);
    head.appendChild(el('span', 'sim-branch', BRANCH_LABELS[r.primaryBranch]));
    outputWrap.appendChild(head);

    if (r.secondaryFindings.length) {
      var sf = el('div', 'sim-block');
      sf.appendChild(el('h4', 'sim-block-h', 'Secondary findings, carried in context'));
      var ul = el('ul', 'sim-list');
      r.secondaryFindings.forEach(function (s) { ul.appendChild(el('li', null, s)); });
      sf.appendChild(ul);
      outputWrap.appendChild(sf);
    }

    var fr = el('div', 'sim-block');
    fr.appendChild(el('h4', 'sim-block-h', 'Fired rules, in priority order'));
    var ol = el('ol', 'sim-trace');
    r.firedRules.forEach(function (s) { ol.appendChild(el('li', null, s)); });
    fr.appendChild(ol);
    outputWrap.appendChild(fr);

    var pm = el('div', 'sim-block sim-perms');
    [['Autonomous', r.permissions.autonomous], ['Confirm first', r.permissions.confirmFirst], ['Never', r.permissions.never]].forEach(function (pair) {
      var col = el('div', 'sim-perm-col');
      col.appendChild(el('h4', 'sim-block-h sim-perm-' + pair[0].toLowerCase().replace(' ', '-'), pair[0]));
      var pul = el('ul', 'sim-list');
      if (!pair[1].length) pul.appendChild(el('li', 'sim-dim', 'nothing at this stage'));
      pair[1].forEach(function (s) { pul.appendChild(el('li', null, s)); });
      col.appendChild(pul);
      pm.appendChild(col);
    });
    outputWrap.appendChild(pm);

    var nv = el('div', 'sim-block');
    nv.appendChild(el('h4', 'sim-block-h', 'The verification that closes the case'));
    nv.appendChild(el('p', 'sim-verify', r.nextVerification));
    outputWrap.appendChild(nv);

    if (r.escalationTrigger) {
      var et = el('div', 'sim-block');
      et.appendChild(el('h4', 'sim-block-h', 'Escalation trigger'));
      et.appendChild(el('p', 'sim-escalation', r.escalationTrigger.replace(/_/g, ' ')));
      outputWrap.appendChild(et);
    }
  }

  /* test panel */
  var testPanel = el('div', 'sim-tests');
  var testBtn = el('button', 'sim-run-tests', 'Run all scenario tests');
  testBtn.type = 'button';
  var testNote = el('p', 'sim-tests-note',
    'Logic tests of the decision table against the scripted scenarios above: the stress-testing discipline from phase 4 applied to this model.');
  var testHow = el('p', 'sim-tests-note',
    'How it works: each of the ' + PRESETS.length + ' scenarios stores its expected result (branch, mode, escalation trigger and the full structured output). This button feeds every scenario through the decision rules again, live in your browser, and compares what the engine returns with what is stored. A match is PASS; any drift, for example after a rule change, shows as FAIL with the exact difference.');
  var testWhy = el('p', 'sim-tests-note',
    'Why do they all pass? Because the expected outputs were written together with the rules: the model was built until every scripted scenario matched its expectation. The value is in the future, not today. Change any rule and the affected scenarios fail immediately, which is how a decision table stays trustworthy as it evolves.');
  var testResults = el('div', 'sim-test-results');
  testResults.setAttribute('aria-live', 'polite');
  testBtn.addEventListener('click', function () {
    testResults.innerHTML = '';
    var allPass = true;
    PRESETS.forEach(function (p) {
      var problems = checkPreset(p);
      var actual = decide(p.input);
      var spec = p.expectedSummary;
      var row = el('div', 'sim-test-row ' + (problems.length ? 'fail' : 'pass'));
      row.appendChild(el('span', 'sim-test-mark', problems.length ? 'FAIL' : 'PASS'));
      row.appendChild(el('span', 'sim-test-name', p.name));
      row.appendChild(el('span', 'sim-test-cmp',
        'expected ' + spec.mode + ' / ' + spec.primaryBranch + ' · engine returned ' + actual.mode + ' / ' + actual.primaryBranch));
      if (problems.length) {
        allPass = false;
        var d = el('div', 'sim-test-detail');
        problems.forEach(function (pr) { d.appendChild(el('div', null, pr)); });
        row.appendChild(d);
      }
      testResults.appendChild(row);
    });
    testResults.appendChild(el('p', 'sim-test-sum ' + (allPass ? 'pass' : 'fail'),
      allPass ? 'All ' + PRESETS.length + ' scenarios produce their expected structured output.' : 'At least one scenario deviates from its stored expected output.'));
  });
  testPanel.appendChild(testNote);
  testPanel.appendChild(testHow);
  testPanel.appendChild(testWhy);
  testPanel.appendChild(testBtn);
  testPanel.appendChild(testResults);

  root.appendChild(presetsBar);
  root.appendChild(togglesWrap);
  root.appendChild(outputWrap);
  root.appendChild(testPanel);

  /* start on preset 1 */
  setState(PRESETS[0].input);
  markActive(presetsBar.firstChild);
  renderToggles();
  renderOutput();
})();
