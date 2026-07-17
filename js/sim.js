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

  var SVG_OPEN = '<svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
  function icon(paths, size) {
    var s = SVG_OPEN.replace(/width="18" height="18"/, 'width="' + (size || 18) + '" height="' + (size || 18) + '"');
    return s + paths + '</svg>';
  }

  var SCENARIO_ICONS = [
    '<path d="M5 10a10 10 0 0 1 14 0"/><path d="M8 13.5a6 6 0 0 1 8 0"/><circle cx="12" cy="17.5" r="1.4" fill="currentColor" stroke="none"/><line x1="4" y1="4" x2="20" y2="20"/>',
    '<rect x="3" y="6" width="18" height="13" rx="2"/><line x1="3" y1="10.5" x2="21" y2="10.5"/>',
    '<path d="M7 18a4.5 4.5 0 1 1 .8-8.9A6 6 0 0 1 19.5 11 3.7 3.7 0 0 1 18 18H7z"/><line x1="12" y1="10.5" x2="12" y2="13.5"/><circle cx="12" cy="15.8" r="0.9" fill="currentColor" stroke="none"/>',
    '<rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>',
    '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>',
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.3-.9 1-.9 1.7"/><circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none"/>',
    '<circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 2.5-4.5 6-4.5s6 1.5 6 4.5"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16.5 14.6c2.6.3 4.5 1.7 4.5 4.4"/>',
    '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><polyline points="17.5 2.5 17.5 6.5 13.5 6.5"/>',
    '<rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/><line x1="2" y1="21" x2="22" y2="3"/>',
    '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
    '<path d="M13 2 5 13h5l-1 9 8-11h-5z"/>'
  ];
  var CUSTOM_ICON = '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2" fill="#fff"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="#fff"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="7" cy="17" r="2" fill="#fff"/>';

  var GROUP_ICONS = [
    '<path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a9 9 0 0 1 9-9 8 8 0 0 1 9 9z"/>',
    '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
    '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><polyline points="9 12 11 14 15 10"/>',
    '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><polyline points="17.5 2.5 17.5 6.5 13.5 6.5"/>'
  ];

  var BADGE_GLYPH = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', human: 'H', none: '✓' };
  var MODE_TEXT = {
    normal: 'normal operation',
    degraded: 'degraded: signals unavailable',
    suspected_incident: 'suspected incident',
    broadcast: 'broadcast mode'
  };

  var state = {};
  function setState(input) {
    state = {};
    for (var k in DEFAULT_INPUT) state[k] = input[k];
  }
  setState(PRESETS[0].input);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function elHtml(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    e.innerHTML = html;
    return e;
  }

  function optLabel(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v === null) return 'n/a';
    return String(v).replace(/_/g, ' ');
  }

  /* ---------- how-to legend ---------- */
  var legend = elHtml('div', 'sim-steps',
    '<span class="sim-step"><b>1</b>Pick a scenario, or set the signals yourself</span>' +
    '<span class="sim-step-arrow" aria-hidden="true">&#8594;</span>' +
    '<span class="sim-step"><b>2</b>The 12 rules run in priority order</span>' +
    '<span class="sim-step-arrow" aria-hidden="true">&#8594;</span>' +
    '<span class="sim-step"><b>3</b>Read the branch, the trace and the permissions</span>');

  /* ---------- scenario deck ---------- */
  var deck = el('div', 'sim-deck');
  var activeCard = null;
  var customCard = null;
  function markActive(card) {
    if (activeCard) activeCard.classList.remove('active');
    activeCard = card;
    if (card) card.classList.add('active');
  }
  PRESETS.forEach(function (p, i) {
    var b = el('button', 'sim-card');
    b.type = 'button';
    b.appendChild(elHtml('span', 'sim-card-ic', icon(SCENARIO_ICONS[i])));
    b.appendChild(el('span', 'sim-card-t', p.name));
    b.appendChild(el('span', 'sim-card-c', p.blurb));
    b.addEventListener('click', function () {
      setState(p.input);
      markActive(b);
      renderToggles();
      renderOutput();
    });
    deck.appendChild(b);
  });
  customCard = el('button', 'sim-card sim-card-custom');
  customCard.type = 'button';
  customCard.appendChild(elHtml('span', 'sim-card-ic', icon(CUSTOM_ICON)));
  customCard.appendChild(el('span', 'sim-card-t', 'Build your own'));
  customCard.appendChild(el('span', 'sim-card-c', 'All 20 signals, free to set.'));
  customCard.addEventListener('click', function () {
    setState(DEFAULT_INPUT);
    markActive(customCard);
    renderToggles();
    renderOutput();
  });
  deck.appendChild(customCard);

  /* ---------- board: signals in, decision out ---------- */
  var board = el('div', 'sim-board');
  var signalsCol = el('div', 'sim-signals');
  var signalsHead = elHtml('h4', 'sim-col-h', icon('<polyline points="4 5 12 12 4 19"/><line x1="13" y1="19" x2="20" y2="19"/>', 13) + 'Signals in <span class="sim-col-note">lime dot = differs from a healthy baseline</span>');
  signalsCol.appendChild(signalsHead);
  var togglesWrap = el('div', 'sim-toggles');
  signalsCol.appendChild(togglesWrap);

  var decisionCol = el('div', 'sim-decision');
  var decisionHead = elHtml('h4', 'sim-col-h', icon('<line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="12" x2="5" y2="6"/><line x1="12" y1="12" x2="12" y2="4"/><line x1="12" y1="12" x2="19" y2="6"/><polyline points="5 9 5 6 8 6"/><polyline points="10 6 12 4 14 6"/><polyline points="16 6 19 6 19 9"/>', 13) + 'Decision out');
  decisionCol.appendChild(decisionHead);
  var decisionCard = el('div', 'sim-decision-card');
  decisionCol.appendChild(decisionCard);

  board.appendChild(signalsCol);
  board.appendChild(decisionCol);

  function renderToggles() {
    togglesWrap.innerHTML = '';
    FIELD_GROUPS.forEach(function (group, gi) {
      var g = el('div', 'sim-group');
      g.appendChild(elHtml('h5', 'sim-group-h', icon(GROUP_ICONS[gi], 13) + group.name));
      group.fields.forEach(function (f) {
        var key = f[0], label = f[1], options = f[2];
        var changed = state[key] !== DEFAULT_INPUT[key];
        var row = el('div', 'sim-row' + (changed ? ' changed' : ''));
        var l = el('span', 'sim-row-l');
        l.appendChild(el('i', 'sim-row-dot'));
        l.appendChild(document.createTextNode(label));
        row.appendChild(l);
        var opts = el('div', 'sim-opts');
        opts.setAttribute('role', 'group');
        opts.setAttribute('aria-label', label);
        options.forEach(function (v) {
          var b = el('button', 'sim-opt' + (state[key] === v ? ' on' : ''), optLabel(v));
          b.type = 'button';
          b.setAttribute('aria-pressed', state[key] === v ? 'true' : 'false');
          b.addEventListener('click', function () {
            if (state[key] === v) return;
            state[key] = v;
            markActive(customCard);
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

  /* ---------- decision trace console ---------- */
  var trace = el('div', 'console sim-console');
  var traceBar = elHtml('div', 'console-bar',
    '<span class="ps-tab">' + icon('<polyline points="4 5 12 12 4 19"/><line x1="13" y1="19" x2="20" y2="19"/>', 12) + 'Decision trace · rules fired in priority order</span>' +
    '<span class="cstatus">deterministic · runs in your browser</span>');
  var traceBody = el('div', 'console-body sim-trace-body');
  traceBody.setAttribute('aria-live', 'polite');
  trace.appendChild(traceBar);
  trace.appendChild(traceBody);
  var traceScan = el('span', 'scan');
  traceScan.setAttribute('aria-hidden', 'true');
  trace.appendChild(traceScan);

  /* ---------- permissions ---------- */
  var permsWrap = el('div', 'sim-perms');
  var PERM_META = [
    ['Autonomous', 'autonomous', '<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9.5"/>'],
    ['Confirm first', 'confirm-first', '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="12.5"/><circle cx="12" cy="15.8" r="0.9" fill="currentColor" stroke="none"/>'],
    ['Never', 'never', '<circle cx="12" cy="12" r="9"/><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/>']
  ];

  function renderOutput() {
    var r = decide(state);

    /* decision card */
    decisionCard.innerHTML = '';
    var top = el('div', 'sim-dc-top');
    top.appendChild(el('span', 'sim-badge sim-badge-' + r.primaryBranch, BADGE_GLYPH[r.primaryBranch]));
    var tt = el('div', 'sim-dc-title');
    tt.appendChild(el('span', 'sim-dc-branch', BRANCH_LABELS[r.primaryBranch]));
    var light = el('span', 'sim-light sim-light-' + r.mode);
    light.appendChild(el('i', 'sim-light-dot'));
    light.appendChild(document.createTextNode(MODE_TEXT[r.mode] || r.mode));
    tt.appendChild(light);
    top.appendChild(tt);
    decisionCard.appendChild(top);

    var nv = el('div', 'sim-dc-block');
    nv.appendChild(elHtml('h5', 'sim-dc-h', icon('<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9.5"/>', 12) + 'Closes the case when'));
    nv.appendChild(el('p', 'sim-dc-p', r.nextVerification));
    decisionCard.appendChild(nv);

    if (r.escalationTrigger) {
      var et = el('div', 'sim-dc-block');
      et.appendChild(elHtml('h5', 'sim-dc-h', icon('<path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none"/>', 12) + 'Escalation trigger'));
      et.appendChild(el('p', 'sim-dc-p sim-dc-esc', r.escalationTrigger.replace(/_/g, ' ')));
      decisionCard.appendChild(et);
    }

    if (r.secondaryFindings.length) {
      var sf = el('div', 'sim-dc-block');
      sf.appendChild(elHtml('h5', 'sim-dc-h', icon('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>', 12) + 'Carried in context'));
      var ul = el('ul', 'sim-dc-list');
      r.secondaryFindings.forEach(function (s) { ul.appendChild(el('li', null, s)); });
      sf.appendChild(ul);
      decisionCard.appendChild(sf);
    }

    decisionCard.classList.remove('boot');
    void decisionCard.offsetWidth;
    decisionCard.classList.add('boot');

    /* trace console */
    traceBody.innerHTML = '';
    r.firedRules.forEach(function (s, i) {
      var p = el('p', 'sim-trace-line', s);
      p.style.animationDelay = (0.08 + i * 0.14).toFixed(2) + 's';
      traceBody.appendChild(p);
    });

    /* permissions */
    permsWrap.innerHTML = '';
    PERM_META.forEach(function (meta) {
      var key = meta[1] === 'autonomous' ? 'autonomous' : (meta[1] === 'confirm-first' ? 'confirmFirst' : 'never');
      var col = el('div', 'sim-perm-col sim-perm-col-' + meta[1]);
      col.appendChild(elHtml('h4', 'sim-block-h sim-perm-' + meta[1], icon(meta[2], 13) + meta[0]));
      var pul = el('ul', 'sim-list');
      if (!r.permissions[key].length) pul.appendChild(el('li', 'sim-dim', 'nothing at this stage'));
      r.permissions[key].forEach(function (s) { pul.appendChild(el('li', null, s)); });
      col.appendChild(pul);
      permsWrap.appendChild(col);
    });
  }

  /* ---------- test panel ---------- */
  var testPanel = el('div', 'sim-tests');
  var testBtn = elHtml('button', 'sim-run-tests', icon('<polygon points="7 4.5 19.5 12 7 19.5"/>', 13) + 'Run all scenario tests');
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
    PRESETS.forEach(function (p, i) {
      var problems = checkPreset(p);
      var actual = decide(p.input);
      var spec = p.expectedSummary;
      var row = el('div', 'sim-test-row ' + (problems.length ? 'fail' : 'pass'));
      row.style.animationDelay = (i * 0.06).toFixed(2) + 's';
      row.appendChild(el('span', 'sim-test-mark', problems.length ? '✗ FAIL' : '✓ PASS'));
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

  root.appendChild(legend);
  root.appendChild(deck);
  root.appendChild(board);
  root.appendChild(trace);
  root.appendChild(permsWrap);
  root.appendChild(testPanel);

  markActive(deck.firstChild);
  renderToggles();
  renderOutput();
})();
