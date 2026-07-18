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
    none: 'No technical fault confirmed'
  };

  var STATUS_LABELS = {
    routed: 'Routed',
    needs_clarification: 'Needs clarification',
    handoff: 'Handoff',
    no_fault_confirmed: 'No fault confirmed'
  };

  var VERIFICATIONS = {
    A: 'Incident resolved and broadcast confirmed; callback kept for this merchant.',
    B: 'Terminal-to-host connection test, then a merchant payment attempt observed in telemetry.',
    C: 'Device reports healthy in telemetry and a merchant payment attempt goes through.',
    D: 'Case accepted by the account specialist inside the SLA; merchant told exactly who takes over.',
    E: 'Merchant confirms understanding; the next genuine card attempt is monitored in the transaction log.',
    F: 'Correct device identified; the case re-enters diagnosis with the right context.',
    human: 'Warm handoff completed with the full context package; the merchant does not repeat themselves.',
    none: 'No technical fault has been confirmed. Clarify the reported symptom, review unresolved secondary findings, or hand off when the clarification budget is exhausted.'
  };

  function basePermissions() {
    return {
      autonomous: [
        'Read the minimum purpose-limited signals required for the active workflow, subject to caller verification, market configuration and audit logging',
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
      locked: [],
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
      status: 'routed',
      mode: 'normal',
      primaryBranch: null,
      provisionalRoute: null,
      requiredNextAction: null,
      secondaryFindings: [],
      firedRules: [],
      permissions: basePermissions(),
      nextVerification: null,
      escalationTriggers: []
    };
    var degraded = false;
    var needsClarification = false;
    var verificationBlocked = false;
    var unexplainedDown = false;
    var payoutFollowUp = false;

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
      out.permissions.confirmFirst = [];
      out.permissions.locked = ['Any remote action (locked while signal systems are down; retried once they return)'];
      out.secondaryFindings.push('System signals unavailable: every conclusion below is provisional until telemetry returns.');
    }

    /* Rule 2: human requested */
    if (input.humanRequested === true) {
      out.primaryBranch = 'human';
      out.firedRules.push('Rule 2 · Human requested: honored on the first request, warm handoff with everything gathered so far.');
      out.escalationTriggers.push('human_requested');
    }

    /* Rule 3: repeat-contact gate, before diagnosis */
    if (out.primaryBranch === null && input.repeatContact === true && input.priorResolutionVerified !== true) {
      out.primaryBranch = 'human';
      out.firedRules.push('Rule 3 · Repeat contact and the previous fix was never verified: straight to a human with full history. The gate fires before diagnosis.');
      out.escalationTriggers.push('repeat_contact_unverified_fix');
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
      out.permissions.autonomous = ['Read the minimum signals needed to assemble the specialist case', 'Create the specialist case with full context'];
      out.permissions.confirmFirst = [];
      out.permissions.locked = [];
      out.permissions.never = [
        'Any troubleshooting or account action on this case: the specialist handles it',
        'Discuss reasons behind a risk or KYC hold',
        'Change payout accounts or financial settings',
        'Promise refunds, credits or waivers'
      ];
    }
    if (!degraded && (input.payoutStatus === 'delayed' || input.payoutStatus === 'blocked') && input.paymentAcceptanceStatus === 'enabled') {
      payoutFollowUp = true;
      out.secondaryFindings.push('Payout ' + input.payoutStatus + ' with payment acceptance enabled: not a branch D emergency. Routed as a specialist follow-up, carried in the case context.');
      out.firedRules.push('Rule 4 · Payout ' + input.payoutStatus + ' but payment acceptance enabled: payments still flow, so this is a secondary finding with a specialist follow-up, not the primary route.');
    }

    /* Rule 5: incident and spike are separate facts */
    if (!degraded && input.incidentConfirmed === true) {
      if (out.primaryBranch === null) {
        out.primaryBranch = 'A';
        if (input.symptomSpike === true) {
          out.mode = 'broadcast';
          out.firedRules.push('Rule 5 · Confirmed platform incident with a symptom spike: branch A in broadcast mode. Inform, suppress invasive troubleshooting, protect the human queue.');
        } else {
          out.firedRules.push('Rule 5 · Confirmed platform incident without a spike: branch A, normal incident handling. Inform, give status and expected resolution, keep a callback.');
        }
      } else {
        out.secondaryFindings.push('Confirmed platform incident running: incident context attached.');
      }
    } else if (!degraded && input.symptomSpike === true) {
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
        out.escalationTriggers.push('clarification_budget_exhausted');
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
      out.secondaryFindings.push('Connectivity fault also present (heartbeat ' + input.heartbeat + '): carried as a secondary finding. Acceptance determines payment availability, so branch B recovery waits for the specialist.');
      out.firedRules.push('Rule 7 · Connectivity fault detected but outranked by the account restriction: logged as a secondary finding, not the primary route.');
    }

    /* Rule 8: declines. With evidence: branch E. Without evidence: never a
       silent fall-through to no-fault. */
    if (out.primaryBranch === null && !degraded && input.recentAttempts === 'present' &&
        (input.recentOutcomes === 'declined' || input.recentOutcomes === 'mixed') && input.declineCodeAvailable === true) {
      out.primaryBranch = 'E';
      out.firedRules.push('Rule 8 · Attempts arriving and declined with codes available: branch E. Show the terminal works, explain the decline codes, reassure with evidence.');
    } else if (out.primaryBranch === null && !degraded && input.reportedSymptom === 'cards_declined' &&
        input.recentAttempts === 'present' && input.recentOutcomes === 'declined' && input.declineCodeAvailable !== true) {
      needsClarification = true;
      out.provisionalRoute = 'E';
      out.requiredNextAction = 'Obtain merchant-safe decline evidence or hand off';
      out.firedRules.push('Rule 8 · Attempts declined but no decline codes are available: card-side declines stay the provisional route, never a confirmed no-fault. Obtain merchant-safe decline evidence or hand off.');
    }

    /* Rule 9: conflicting or ambiguous evidence on a down symptom */
    var downSymptom = DOWN_SYMPTOMS.indexOf(input.reportedSymptom) !== -1;
    var ct = input.connectionTestResult;
    var ctDecisive = ct === 'connectivity_failure' || ct === 'device_failure';
    var successEvidence = input.recentOutcomes === 'successful' || input.recentOutcomes === 'mixed';

    if (out.primaryBranch === null && !needsClarification && !degraded && downSymptom && successEvidence && !ctDecisive) {
      needsClarification = true;
      out.provisionalRoute = SYMPTOM_FALLBACK_BRANCH[input.reportedSymptom] || 'B';
      out.requiredNextAction = 'Clarify which terminal is affected, when it last worked, and whether the fault is intermittent';
      out.firedRules.push('Rule 9 · Recent outcomes include successful payments while the merchant reports a down symptom: possible multi-terminal ambiguity. No branch is final until the affected terminal is identified.');
    }

    if (out.primaryBranch === null && !needsClarification && !degraded && input.heartbeat === 'ok' && downSymptom) {
      out.firedRules.push('Rule 9 · Telemetry says online but the merchant says down: trust neither alone. Treat telemetry as possibly stale; the terminal-to-host connection test decides.');
      if (ct === 'connectivity_failure') {
        out.primaryBranch = 'B';
        out.firedRules.push('Rule 9 · Connection test failed on connectivity: the link is down and telemetry was stale. Branch B guided recovery.');
      } else if (ct === 'device_failure') {
        out.primaryBranch = 'C';
        out.firedRules.push('Rule 9 · Connection test failed on the device side: the link is fine, the device is not. Branch C.');
      } else if (ct === 'passed') {
        unexplainedDown = true;
        out.firedRules.push('Rule 9 · Connection test passed: the terminal-to-host path works. The remaining evidence (attempts, device identity, device state) must explain the symptom.');
      } else if (ct === 'unavailable') {
        needsClarification = true;
        out.provisionalRoute = SYMPTOM_FALLBACK_BRANCH[input.reportedSymptom] || 'B';
        out.requiredNextAction = 'Proceed on the reported symptom with reduced autonomy until the connection-test tool returns';
        out.permissions.locked.push('Remote-restart and software update (locked: connection-test evidence unavailable)');
        out.permissions.confirmFirst = out.permissions.confirmFirst.filter(function (s) {
          return s !== 'Push software update' && s !== 'Remote-restart the terminal';
        });
        out.firedRules.push('Rule 9 · Connection test unavailable: degraded evidence. Provisional route from the reported symptom, reduced autonomy until the tool returns.');
      } else {
        needsClarification = true;
        out.provisionalRoute = input.reportedSymptom === 'frozen_screen' ? 'C' : 'B';
        out.requiredNextAction = 'Run the terminal-to-host connection test';
        out.firedRules.push('Rule 9 · The connection test has not been run: no final branch on conflicting telemetry. ' + BRANCH_LABELS[out.provisionalRoute] + ' is the provisional route while the test is pending.');
      }
    }

    /* Rule 10: device state */
    var faultyDevice = ['frozen', 'hardware_error', 'firmware_outdated', 'update_pending'].indexOf(input.deviceState) !== -1;
    if (!degraded && faultyDevice) {
      if (out.primaryBranch === null && !needsClarification) {
        out.primaryBranch = 'C';
        unexplainedDown = false;
        out.firedRules.push('Rule 10 · Device state is ' + input.deviceState.replace(/_/g, ' ') + ': branch C. Updates and remote restarts are confirm-first.');
      } else if (out.primaryBranch !== 'C') {
        out.secondaryFindings.push('Device state ' + input.deviceState.replace(/_/g, ' ') + ': carried as a secondary finding in the case context.');
      }
    }
    if (!degraded && input.market === 'DE' && (out.primaryBranch === 'C' || out.provisionalRoute === 'C' || faultyDevice)) {
      var i = out.permissions.confirmFirst.indexOf('Push software update');
      if (i !== -1) out.permissions.confirmFirst.splice(i, 1);
      out.permissions.locked.unshift('Push software update (DE: locked pending validation of fiscal-device TSE implications; a conservative provisional configuration, not a statement of German law or Flatpay architecture)');
      out.firedRules.push('Rule 10 · Market overlay DE: software-update autonomy locked pending TSE validation.');
    }

    /* Rule 11: verification level */
    if (input.verificationLevel === 'employee_low_assurance') {
      out.permissions.locked.unshift('Account data and payment fallbacks (locked: caller verified at low assurance, hardware troubleshooting only)');
      out.firedRules.push('Rule 11 · Caller is an employee at low assurance: hardware troubleshooting allowed, account data and payment fallbacks locked pending verification.');
    } else if (input.verificationLevel === 'failed') {
      verificationBlocked = true;
      out.escalationTriggers.push('verification_failed');
      out.permissions.autonomous = ['Guide the caller through identity verification', 'Non-sensitive hardware guidance only (power, cabling, reboot)'];
      out.permissions.confirmFirst = [];
      out.permissions.locked = ['All account data and account actions (locked until the caller passes verification)'];
      out.firedRules.push('Rule 11 · Verification failed: the identity gate is active. No confident branch while identity blocks; account actions locked, only non-sensitive hardware guidance allowed.');
    }

    /* Rule 12: fix-cycle budget */
    if (input.failedFixCycles >= 2) {
      if (out.primaryBranch !== null && out.primaryBranch !== 'human') {
        out.secondaryFindings.push('Diagnosis so far (' + BRANCH_LABELS[out.primaryBranch] + ') travels with the handoff; nothing is repeated.');
      }
      out.primaryBranch = 'human';
      out.firedRules.push('Rule 12 · Two fix cycles failed verification: hard stop. Warm handoff with everything tried; never a third loop.');
      out.escalationTriggers.push('two_failed_fix_cycles');
    }

    /* Degraded fallback: diagnose from the reported symptom only */
    if (out.primaryBranch === null && !needsClarification && degraded) {
      out.primaryBranch = SYMPTOM_FALLBACK_BRANCH[input.reportedSymptom] || 'human';
      out.firedRules.push('Rule 1 · Reported symptom "' + input.reportedSymptom.replace(/_/g, ' ') + '" maps to ' + BRANCH_LABELS[out.primaryBranch] + ' as a working hypothesis, verified by the merchant’s own payment attempt.');
    }

    /* Verification gate: no confident branch while identity blocks */
    if (verificationBlocked && out.primaryBranch !== 'human') {
      if (out.primaryBranch !== null && out.primaryBranch !== 'none') {
        out.provisionalRoute = out.primaryBranch;
      }
      out.primaryBranch = null;
      needsClarification = true;
      out.requiredNextAction = 'Complete caller identity verification; account-linked steps stay locked until identity passes';
    }

    /* Connection test passed but the down symptom is still unexplained */
    if (out.primaryBranch === null && !needsClarification && unexplainedDown) {
      needsClarification = true;
      out.provisionalRoute = 'F';
      out.requiredNextAction = 'Disambiguate the device identity against the product registry';
      out.firedRules.push('Rule 9 · Nothing else in the evidence explains the symptom: the reported device may not be the tested device. Device disambiguation is the next action.');
    }

    /* No rule produced a branch or a pending clarification: no fault confirmed */
    if (out.primaryBranch === null && !needsClarification) {
      out.primaryBranch = 'none';
      out.firedRules.push('No blocker on payment availability found in the signals. Anything the merchant raised is carried as a follow-up, not forced into a technical branch.');
    }

    /* Status */
    if (out.primaryBranch === 'human') {
      out.status = 'handoff';
    } else if (needsClarification) {
      out.status = 'needs_clarification';
      out.primaryBranch = null;
    } else if (out.primaryBranch === 'none') {
      out.status = 'no_fault_confirmed';
    } else {
      out.status = 'routed';
    }

    /* Closing condition */
    if (out.status === 'needs_clarification') {
      out.nextVerification = 'No branch is final. Required next action: ' + out.requiredNextAction + '.';
    } else if (out.primaryBranch === 'none' && payoutFollowUp) {
      out.nextVerification = 'Specialist follow-up on the payout is created and confirmed; the merchant knows who owns the case and when to expect an update.';
    } else {
      out.nextVerification = VERIFICATIONS[out.primaryBranch];
    }

    if (out.primaryBranch === 'D' && out.escalationTriggers.indexOf('account_restriction_specialist_handoff') === -1) {
      out.escalationTriggers.push('account_restriction_specialist_handoff');
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
    connectionTestResult: 'not_run',
    paymentAcceptanceStatus: 'enabled',
    payoutStatus: 'normal',
    accountReviewStatus: 'none',
    incidentConfirmed: false,
    symptomSpike: false,
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
      ['connectionTestResult', 'Connection test', ['not_run', 'passed', 'connectivity_failure', 'device_failure', 'unavailable']],
      ['deviceState', 'Device state', ['healthy', 'frozen', 'hardware_error', 'firmware_outdated', 'update_pending', 'unavailable']],
      ['paymentAcceptanceStatus', 'Payment acceptance', ['enabled', 'restricted', 'blocked', 'unknown']],
      ['payoutStatus', 'Payout status', ['normal', 'delayed', 'blocked', 'unknown']],
      ['accountReviewStatus', 'Account review', ['none', 'review_present', 'unknown']],
      ['incidentConfirmed', 'Incident confirmed', [false, true]],
      ['symptomSpike', 'Symptom spike', [false, true]]
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
    scenario('3 · Confirmed incident, symptom spiking',
      'Incident confirmed while the same symptom spikes: broadcast mode.',
      { incidentConfirmed: true, symptomSpike: true, recentAttempts: 'present', recentOutcomes: 'unavailable' }),
    scenario('4 · Acceptance blocked, review present',
      'Payments stopped: the account, not the hardware.',
      { reportedSymptom: 'worked_earlier', paymentAcceptanceStatus: 'blocked', accountReviewStatus: 'review_present' }),
    scenario('5 · Frozen screen, device fails the test',
      'Telemetry says online; the connection test blames the device.',
      { reportedSymptom: 'frozen_screen', connectionTestResult: 'device_failure' }),
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
      { signalApisReachable: false }),
    scenario('12 · Telemetry ok, merchant says down',
      'Conflicting evidence: no final branch until the connection test runs.',
      {}),
    scenario('13 · Declines without codes',
      'Attempts declined, no decline evidence available yet.',
      { reportedSymptom: 'cards_declined', recentAttempts: 'present', recentOutcomes: 'declined', declineCodeAvailable: false }),
    scenario('14 · Caller fails verification',
      'Terminal is down, but identity blocks everything account-linked.',
      { heartbeat: 'missing', deviceState: 'unavailable', verificationLevel: 'failed' })
  ];

  /* Independent expectations, written by hand per preset: branch, mode,
     status, triggers and contains-checks. These are the real tests. */
  var EXPECTED = [
    { status: 'routed', mode: 'normal', primaryBranch: 'B', provisionalRoute: null, escalationTriggers: [] },
    { status: 'routed', mode: 'normal', primaryBranch: 'E', provisionalRoute: null, escalationTriggers: [] },
    { status: 'routed', mode: 'broadcast', primaryBranch: 'A', provisionalRoute: null, escalationTriggers: [] },
    { status: 'routed', mode: 'normal', primaryBranch: 'D', provisionalRoute: null, escalationTriggers: ['account_restriction_specialist_handoff'] },
    { status: 'routed', mode: 'normal', primaryBranch: 'C', provisionalRoute: null, escalationTriggers: [] },
    { status: 'routed', mode: 'normal', primaryBranch: 'F', provisionalRoute: null, escalationTriggers: [] },
    { status: 'routed', mode: 'normal', primaryBranch: 'B', provisionalRoute: null, escalationTriggers: [],
      lockedContains: 'Account data and payment fallbacks' },
    { status: 'handoff', mode: 'normal', primaryBranch: 'human', provisionalRoute: null, escalationTriggers: ['repeat_contact_unverified_fix'] },
    { status: 'routed', mode: 'normal', primaryBranch: 'D', provisionalRoute: null, escalationTriggers: ['account_restriction_specialist_handoff'],
      secondaryContains: 'Connectivity fault also present' },
    { status: 'no_fault_confirmed', mode: 'normal', primaryBranch: 'none', provisionalRoute: null, escalationTriggers: [],
      secondaryContains: 'Payout delayed', verificationContains: 'Specialist follow-up on the payout' },
    { status: 'routed', mode: 'degraded', primaryBranch: 'B', provisionalRoute: null, escalationTriggers: [] },
    { status: 'needs_clarification', mode: 'normal', primaryBranch: null, provisionalRoute: 'B', escalationTriggers: [],
      actionContains: 'connection test' },
    { status: 'needs_clarification', mode: 'normal', primaryBranch: null, provisionalRoute: 'E', escalationTriggers: [],
      actionContains: 'decline evidence' },
    { status: 'needs_clarification', mode: 'normal', primaryBranch: null, provisionalRoute: 'B', escalationTriggers: ['verification_failed'],
      actionContains: 'identity verification' }
  ];
  PRESETS.forEach(function (p, i) {
    var full = decide(p.input);
    p.expected = full; /* snapshot for the regression guard, not a test oracle */
    p.expectedSummary = EXPECTED[i];
  });

  function checkPreset(p) {
    var actual = decide(p.input);
    var spec = p.expectedSummary;
    var problems = [];
    if (actual.status !== spec.status) problems.push('status: expected ' + spec.status + ', got ' + actual.status);
    if (actual.mode !== spec.mode) problems.push('mode: expected ' + spec.mode + ', got ' + actual.mode);
    if (actual.primaryBranch !== spec.primaryBranch) problems.push('primaryBranch: expected ' + spec.primaryBranch + ', got ' + actual.primaryBranch);
    if (actual.provisionalRoute !== spec.provisionalRoute) problems.push('provisionalRoute: expected ' + spec.provisionalRoute + ', got ' + actual.provisionalRoute);
    if (actual.escalationTriggers.join('|') !== spec.escalationTriggers.join('|')) {
      problems.push('escalationTriggers: expected [' + spec.escalationTriggers.join(', ') + '], got [' + actual.escalationTriggers.join(', ') + ']');
    }
    if (spec.lockedContains && !actual.permissions.locked.some(function (s) { return s.indexOf(spec.lockedContains) !== -1; })) {
      problems.push('permissions.locked missing "' + spec.lockedContains + '"');
    }
    if (spec.neverContains && !actual.permissions.never.some(function (s) { return s.indexOf(spec.neverContains) !== -1; })) {
      problems.push('permissions.never missing "' + spec.neverContains + '"');
    }
    if (spec.secondaryContains && !actual.secondaryFindings.some(function (s) { return s.indexOf(spec.secondaryContains) !== -1; })) {
      problems.push('secondaryFindings missing "' + spec.secondaryContains + '"');
    }
    if (spec.actionContains && (actual.requiredNextAction === null || actual.requiredNextAction.indexOf(spec.actionContains) === -1)) {
      problems.push('requiredNextAction missing "' + spec.actionContains + '"');
    }
    if (spec.verificationContains && (actual.nextVerification === null || actual.nextVerification.indexOf(spec.verificationContains) === -1)) {
      problems.push('nextVerification missing "' + spec.verificationContains + '"');
    }
    var snapshotDrift = JSON.stringify(actual) !== JSON.stringify(p.expected);
    return { problems: problems, snapshotDrift: snapshotDrift };
  }

  /* ==================== exports for tests / UI ==================== */

  var api = {
    decide: decide,
    DEFAULT_INPUT: DEFAULT_INPUT,
    FIELD_GROUPS: FIELD_GROUPS,
    PRESETS: PRESETS,
    BRANCH_LABELS: BRANCH_LABELS,
    STATUS_LABELS: STATUS_LABELS,
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
    '<path d="M13 2 5 13h5l-1 9 8-11h-5z"/>',
    '<path d="M9 7V3"/><path d="M15 7V3"/><rect x="7" y="7" width="10" height="6" rx="2"/><line x1="12" y1="13" x2="12" y2="20"/>',
    '<rect x="3" y="6" width="18" height="13" rx="2"/><line x1="3" y1="10.5" x2="21" y2="10.5"/><path d="M10.5 14.2a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.6-.7 1"/><circle cx="12" cy="17.8" r="0.8" fill="currentColor" stroke="none"/>',
    '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><line x1="9.5" y1="9.5" x2="14.5" y2="14.5"/><line x1="14.5" y1="9.5" x2="9.5" y2="14.5"/>'
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
    '<span class="sim-step"><b>3</b>Read the status, the trace and the permissions</span>');

  /* ---------- scenario deck ---------- */
  var deck = el('div', 'sim-deck');
  var activeCard = null;
  var customCard = null;
  function markActive(card) {
    if (activeCard) {
      activeCard.classList.remove('active');
      activeCard.setAttribute('aria-pressed', 'false');
    }
    activeCard = card;
    if (card) {
      card.classList.add('active');
      card.setAttribute('aria-pressed', 'true');
    }
  }
  PRESETS.forEach(function (p, i) {
    var b = el('button', 'sim-card');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
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
  customCard.setAttribute('aria-pressed', 'false');
  customCard.appendChild(elHtml('span', 'sim-card-ic', icon(CUSTOM_ICON)));
  customCard.appendChild(el('span', 'sim-card-t', 'Build your own'));
  customCard.appendChild(el('span', 'sim-card-c', 'All 22 signals, free to set.'));
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
  var announcer = el('p', 'sim-vh');
  announcer.setAttribute('aria-live', 'polite');
  decisionCol.appendChild(announcer);

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

  /* ---------- decision trace: rule nodes on a trunk ---------- */
  var trace = el('div', 'sim-tracepanel');
  trace.appendChild(elHtml('h4', 'sim-col-h',
    icon('<line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="12" x2="5" y2="6"/><line x1="12" y1="12" x2="12" y2="4"/><line x1="12" y1="12" x2="19" y2="6"/><polyline points="5 9 5 6 8 6"/><polyline points="10 6 12 4 14 6"/><polyline points="16 6 19 6 19 9"/>', 13) +
    'Decision trace · rules fired in priority order <span class="sim-col-note">deterministic, runs in your browser</span>'));
  var traceList = el('ol', 'sim-tracelist');
  trace.appendChild(traceList);

  /* ---------- permissions ---------- */
  var permsWrap = el('div', 'sim-perms');
  var PERM_META = [
    ['Autonomous', 'autonomous', '<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9.5"/>'],
    ['Confirm first', 'confirm-first', '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="12.5"/><circle cx="12" cy="15.8" r="0.9" fill="currentColor" stroke="none"/>'],
    ['Locked', 'locked', '<rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>'],
    ['Never', 'never', '<circle cx="12" cy="12" r="9"/><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/>']
  ];
  var PERM_KEYS = { autonomous: 'autonomous', 'confirm-first': 'confirmFirst', locked: 'locked', never: 'never' };
  var PERM_NOTES = {
    autonomous: 'acts without asking',
    'confirm-first': 'explicit yes required',
    locked: 'pending verification or system state',
    never: 'prohibited at all times'
  };

  function renderOutput() {
    var r = decide(state);

    /* decision card */
    decisionCard.innerHTML = '';
    var statusRow = el('div', 'sim-dc-statusrow');
    statusRow.appendChild(el('span', 'sim-statuschip sim-statuschip-' + r.status, STATUS_LABELS[r.status]));
    var light = el('span', 'sim-light sim-light-' + r.mode);
    light.appendChild(el('i', 'sim-light-dot'));
    light.appendChild(document.createTextNode(MODE_TEXT[r.mode] || r.mode));
    statusRow.appendChild(light);
    decisionCard.appendChild(statusRow);

    var top = el('div', 'sim-dc-top');
    if (r.primaryBranch) {
      top.appendChild(el('span', 'sim-badge sim-badge-' + r.primaryBranch, BADGE_GLYPH[r.primaryBranch]));
      var tt = el('div', 'sim-dc-title');
      tt.appendChild(el('span', 'sim-dc-branch', BRANCH_LABELS[r.primaryBranch]));
      top.appendChild(tt);
    } else {
      top.appendChild(el('span', 'sim-badge sim-badge-clarify', '?'));
      var tc = el('div', 'sim-dc-title');
      tc.appendChild(el('span', 'sim-dc-branch', 'No final branch yet'));
      if (r.provisionalRoute) {
        tc.appendChild(el('span', 'sim-dc-prov', 'Provisional route · ' + BRANCH_LABELS[r.provisionalRoute]));
      }
      top.appendChild(tc);
    }
    decisionCard.appendChild(top);

    if (r.requiredNextAction) {
      var na = el('div', 'sim-dc-block');
      na.appendChild(elHtml('h5', 'sim-dc-h', icon('<circle cx="12" cy="12" r="9"/><polyline points="10 8 15 12 10 16"/>', 12) + 'Required next action'));
      na.appendChild(el('p', 'sim-dc-p', r.requiredNextAction));
      decisionCard.appendChild(na);
    }

    var nv = el('div', 'sim-dc-block');
    nv.appendChild(elHtml('h5', 'sim-dc-h', icon('<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9.5"/>', 12) + 'Closes the case when'));
    nv.appendChild(el('p', 'sim-dc-p', r.nextVerification));
    decisionCard.appendChild(nv);

    if (r.escalationTriggers.length) {
      var et = el('div', 'sim-dc-block');
      et.appendChild(elHtml('h5', 'sim-dc-h', icon('<path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none"/>', 12) + 'Escalation triggers · in the order they fired'));
      var eul = el('ul', 'sim-dc-list sim-dc-esc');
      r.escalationTriggers.forEach(function (t) { eul.appendChild(el('li', null, t.replace(/_/g, ' '))); });
      et.appendChild(eul);
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

    announcer.textContent = 'Decision: ' + STATUS_LABELS[r.status] + '. ' +
      (r.primaryBranch ? BRANCH_LABELS[r.primaryBranch] : 'No final branch yet' +
        (r.provisionalRoute ? '; provisional route ' + BRANCH_LABELS[r.provisionalRoute] : '')) +
      '. Mode: ' + (MODE_TEXT[r.mode] || r.mode) + '.';

    /* trace list */
    traceList.innerHTML = '';
    var packet = el('span', 'sim-trace-packet');
    packet.setAttribute('aria-hidden', 'true');
    traceList.appendChild(packet);
    r.firedRules.forEach(function (s, i) {
      var m = s.match(/^Rule (\d+) · ([\s\S]*)$/);
      var li = el('li', 'sim-trace-li');
      li.style.animationDelay = (0.08 + i * 0.14).toFixed(2) + 's';
      li.appendChild(el('span', 'sim-trace-n', m ? m[1] : '·'));
      li.appendChild(el('span', 'sim-trace-t', m ? m[2] : s));
      traceList.appendChild(li);
    });

    /* permissions */
    permsWrap.innerHTML = '';
    PERM_META.forEach(function (meta) {
      var key = PERM_KEYS[meta[1]];
      var col = el('div', 'sim-perm-col sim-perm-col-' + meta[1]);
      col.appendChild(elHtml('h4', 'sim-block-h sim-perm-' + meta[1], icon(meta[2], 13) + meta[0] + ' <span class="sim-perm-note">' + PERM_NOTES[meta[1]] + '</span>'));
      var pul = el('ul', 'sim-list');
      if (!r.permissions[key].length) pul.appendChild(el('li', 'sim-dim', 'nothing at this stage'));
      r.permissions[key].forEach(function (s) { pul.appendChild(el('li', null, s)); });
      col.appendChild(pul);
      permsWrap.appendChild(col);
    });
  }

  /* ---------- scenario test suite ---------- */
  var testPanel = el('div', 'sim-tests');
  var testsHead = elHtml('div', 'sim-tests-head',
    icon('<path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><line x1="8.5" y1="3" x2="15.5" y2="3"/><line x1="8" y1="15" x2="16" y2="15"/>', 14) +
    '<h4>Scenario test suite</h4><span class="sim-tests-badge">' + PRESETS.length + ' scripted scenarios · independent expectations + snapshot guard</span>');
  var testNote = el('p', 'sim-tests-note',
    'Logic tests that compare the decision model against independently defined expectations for the scripted scenarios, plus a snapshot regression guard.');
  var testInfo = document.createElement('details');
  testInfo.className = 'sim-tests-info';
  var testInfoSum = document.createElement('summary');
  testInfoSum.textContent = 'How it works, and why every scenario passes today';
  testInfo.appendChild(testInfoSum);
  testInfo.appendChild(el('p', null,
    'Each of the ' + PRESETS.length + ' scenarios carries a hand-written expectation, defined independently of the engine: status, branch or provisional route, mode, escalation triggers and targeted contains-checks. Running the suite feeds every scenario through the decision rules again, live in your browser, and compares field by field; any mismatch shows as FAIL with the exact difference. A separate snapshot comparison (regression guard) also checks the full structured output against a stored copy: it catches accidental drift in fields the expectations do not name, and it is a guard, not a validation.'));
  testInfo.appendChild(el('p', null,
    'Why do they all pass? Because the model was built until every scripted scenario matched its independently written expectation. The value is in the future, not today: change any rule and the affected scenarios fail immediately, which is how a decision table stays trustworthy as it evolves.'));
  var testBtn = elHtml('button', 'sim-run-tests', icon('<polygon points="7 4.5 19.5 12 7 19.5"/>', 13) + 'Run all scenario tests');
  testBtn.type = 'button';
  var testResults = el('div', 'sim-test-results');
  testResults.setAttribute('aria-live', 'polite');
  function resultBrief(status, branch, prov) {
    var s = STATUS_LABELS[status] || String(status);
    if (branch) return s + ' · ' + branch;
    if (prov) return s + ' · provisional ' + prov;
    return s;
  }
  testBtn.addEventListener('click', function () {
    testResults.innerHTML = '';
    var passCount = 0;
    var cards = [];
    PRESETS.forEach(function (p, i) {
      var check = checkPreset(p);
      var actual = decide(p.input);
      var spec = p.expectedSummary;
      var failed = check.problems.length > 0 || check.snapshotDrift;
      if (!failed) passCount++;
      var card = el('div', 'sim-test-card' + (failed ? ' fail' : ''));
      card.style.animationDelay = (0.15 + i * 0.07).toFixed(2) + 's';
      var head = el('div', 'sim-test-card-head');
      head.appendChild(el('span', 'sim-test-mark', failed ? '✗ FAIL' : '✓ PASS'));
      head.appendChild(el('span', 'sim-test-name', p.name));
      card.appendChild(head);
      card.appendChild(el('span', 'sim-test-cmp',
        'expected ' + resultBrief(spec.status, spec.primaryBranch, spec.provisionalRoute) +
        ' · engine returned ' + resultBrief(actual.status, actual.primaryBranch, actual.provisionalRoute)));
      if (check.problems.length) {
        var d = el('div', 'sim-test-detail');
        check.problems.forEach(function (pr) { d.appendChild(el('div', null, pr)); });
        card.appendChild(d);
      }
      if (check.snapshotDrift) {
        var sd = el('div', 'sim-test-detail sim-test-snap');
        sd.appendChild(el('div', null, 'snapshot comparison (regression guard): the full output drifted from the stored snapshot'));
        card.appendChild(sd);
      }
      cards.push(card);
    });

    var allPass = passCount === PRESETS.length;
    var sumbar = el('div', 'sim-test-sumbar' + (allPass ? '' : ' fail'));
    var fill = el('span', 'sim-test-fill');
    sumbar.appendChild(fill);
    var sumtext = el('span', 'sim-test-sumtext');
    sumtext.appendChild(el('b', 'sim-test-count', passCount + ' / ' + PRESETS.length));
    sumtext.appendChild(document.createTextNode(allPass
      ? ' scenarios match their independent expectations and the snapshot guard'
      : ' scenarios match; at least one deviates from its expectation or snapshot'));
    sumbar.appendChild(sumtext);
    testResults.appendChild(sumbar);

    var grid = el('div', 'sim-test-grid');
    cards.forEach(function (c) { grid.appendChild(c); });
    testResults.appendChild(grid);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        fill.style.width = ((passCount / PRESETS.length) * 100).toFixed(0) + '%';
      });
    });
  });
  testPanel.appendChild(testsHead);
  testPanel.appendChild(testNote);
  testPanel.appendChild(testInfo);
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
