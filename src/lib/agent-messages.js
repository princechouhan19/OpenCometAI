import { AGENT_ROLE, compactPageContext } from './agent-runtime.js';
import { buildActionPrompt, buildPlanPrompt } from './prompts.js';
import { peekLibrarySkills } from './skill-library.js';

export function shouldRetryCompactAction(err, settings = {}) {
  const provider = String(settings.provider || '').toLowerCase();
  if (!['mistral', 'ollama'].includes(provider)) return false;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('prompt contains') || msg.includes('context length') || msg.includes('too large') || msg.includes('maximum context');
}

export function shouldPreferTextExtraction(agentState = {}) {
  if (agentState.taskProfile === 'summarize') return true;
  return (agentState.skills || []).some(skill => String(skill?.id || '').toLowerCase().includes('summar'));
}

function createPromptMemory(agentState = {}) {
  const compaction = agentState?.taskMemory?.compaction || {};
  return {
    ...(agentState.taskMemory || {}),
    loopState: agentState.loopState || {},
    compactionStatus: {
      lastCompactedStepCount: compaction.lastCompactedStepCount || 0,
      lastCompactedIteration: compaction.lastCompactedIteration || 0,
      hasWorkSummary: Boolean(agentState?.taskMemory?.workSummary),
    },
  };
}

function buildGroundingAppendix(pageInfo = {}) {
  return [
    '',
    '=== PAGE INSIGHTS ===',
    JSON.stringify(pageInfo.pageInsights || {}, null, 2),
    '',
    '=== SCREENSHOT GROUNDING (badge N -> uid:nx-N) ===',
    JSON.stringify(pageInfo.screenshotAnchors || [], null, 2),
    '',
    '=== SELECTOR MAP ===',
    JSON.stringify(pageInfo.selectorMap || {}, null, 2),
    '',
    'Grounding rules:',
    '- Prefer uid selectors from interactiveElements.',
    '- If the screenshot shows badge N, map it to uid:nx-N.',
    '- Use screenshot anchor centers for x/y only when a matching anchor is present.',
    '- Use selectorMap, label, axName, domPath, and stableKey to re-identify rerendered elements.',
  ].join('\n');
}

export function buildPlannerRequest(agentState, pageInfo, screenshot, options = {}) {
  const plannerPageInfo = compactPageContext(pageInfo, agentState?.settings || {}, {
    role: AGENT_ROLE.PLANNER,
    taskProfile: agentState?.taskProfile,
  });

  return {
    prompt: [
      buildPlanPrompt(agentState?.task || '', plannerPageInfo, screenshot, {
        profile: agentState?.taskProfile || 'default',
        userNotes: agentState?.userNotes || [],
        attachments: agentState?.attachments || [],
        skills: agentState?.skills || [],
        skillLibrary: peekLibrarySkills(),
        memory: agentState?.taskMemory || {},
        profileData: agentState?.settings?.profileData || {},
      }),
      buildGroundingAppendix(plannerPageInfo),
    ].join('\n\n'),
    screenshotBase64: screenshot,
    images: options.images || [],
  };
}

export function buildNavigatorRequest(agentState, pageInfo, screenshot, options = {}) {
  const compactMode = options.compactMode || 'normal';
  const promptPageInfo = compactPageContext(pageInfo, agentState?.settings || {}, {
    role: AGENT_ROLE.NAVIGATOR,
    taskProfile: agentState?.taskProfile,
    forceMinimal: compactMode === 'minimal',
  });
  const textFirstMode = shouldPreferTextExtraction(agentState);
  const includeScreenshot = !textFirstMode && compactMode !== 'minimal';

  return {
    prompt: [
      buildActionPrompt(
        agentState?.task || '',
        agentState?.plan,
        promptPageInfo,
        screenshot,
        (agentState?.steps || []).slice(-10),
        agentState?.iterationCount || 0,
        {
          profile: agentState?.taskProfile || 'default',
          userNotes: agentState?.userNotes || [],
          attachments: agentState?.attachments || [],
          skills: agentState?.skills || [],
          skillLibrary: peekLibrarySkills(),
          memory: createPromptMemory(agentState),
          profileData: agentState?.settings?.profileData || {},
          workSummary: agentState?.taskMemory?.workSummary || '',
        }
      ),
      buildGroundingAppendix(promptPageInfo),
      '',
      'When using click with x/y, only emit coordinates that match a screenshot anchor center from the grounding data above.',
    ].join('\n\n'),
    screenshotBase64: includeScreenshot ? screenshot : null,
    images: includeScreenshot ? (options.images || []) : [],
  };
}

export function buildHistoryCompactionPrompt(agentState, completedSteps = '') {
  const prior = agentState?.taskMemory?.workSummary
    ? `Prior summary:\n${agentState.taskMemory.workSummary}\n\n`
    : '';

  return `You are a task progress summarizer for an AI browser agent.
Summarize what has been accomplished so far in this browser task. Be factual and concise (max 200 words).

TASK: ${agentState?.task || ''}

${prior}RECENT STEPS:
${completedSteps}

Write a terse, factual summary of what has been done. Focus on: pages visited, data found, actions completed, and any failures. Do NOT speculate about future steps.`;
}
