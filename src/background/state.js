// src/background/state.js
// Agent state factory and mutation helpers.

export function createEmptyAgentState(overrides = {}) {
  return {
    // Control flags
    running:       false,
    paused:        false,
    stopRequested: false,
    finalStatus:   'idle',
    finalReport:   '',
    finalData:     {},

    // Session identity
    sessionId:  null,
    task:        '',
    taskProfile: 'default',
    mode:        'ask',

    // Tab tracking
    currentTabId:  null,
    agentTabId:    null,
    agentGroupId:  null,
    taskTabIds:    [],
    taskTabGraph:  {},

    // AI context
    plan:               null,
    currentPlanItemIndex: 0,
    planGenerationStep: null,
    settings:           {},
    iterationCount:     0,
    maxIterations:      25,
    steps:              [],
    currentStepIndex:   0,

    // Approval
    pendingApproval:         null,
    sessionApprovedHosts:    [],
    plannedHosts:            [],

    // User additions
    userNotes:   [],
    attachments: [],
    skills:      [],
    profileData: {},
    licenseStatus: { valid: true },
    consecutiveFailures: 0,

    // Anti-loop memory
    loopState: {
      lastPageSignature:       '',
      lastScreenshotSignature: '',
      repeatedPageCount:       0,
      repeatedScreenshotCount: 0,
      noProgressScrolls:       0,
      repeatedActionCount:     0,
      lastActionKey:           '',
    },
    taskMemory: {
      visitedHosts: [],
      pageSnapshots: [],
      loopHints:    [],
      runtimeNudges: [],
      workSummary:  '',
      compaction: {
        lastCompactedStepCount: 0,
        lastCompactedIteration: 0,
      },
    },
    taskUsage: {
      promptTokens:     0,
      completionTokens: 0,
      totalTokens:      0,
      cost:             0,
    },
    subAgentTrail: [],
    exports:       [],
    lastPageInfo:   null,
    lastScreenshot: '',

    // Start context
    startUrl:   '',
    startTitle: '',

    ...overrides,
  };
}
