// server/routes/doctor.js
const express = require('express');
const { readJson, writeJson } = require('../utils/store');
const { requireRole } = require('../utils/auth');
const { QUESTIONNAIRES, ORDER, computeStatus } = require('../utils/questionnaires');

const router = express.Router();
router.use(requireRole('doctor'));

async function loadData() {
  return readJson('sessions.json', { cases: [], sessions: [] });
}

async function loadResponses() {
  return readJson('responses.json', {});
}

// Finds the next sequential integer id across ALL doctors' response
// records, so every (doctor, session) review that gets started has a
// stable, unique reference number for research/data-export purposes.
function nextResponseId(responses) {
  let max = 0;
  for (const uname of Object.keys(responses)) {
    for (const sid of Object.keys(responses[uname] || {})) {
      const rid = responses[uname][sid] && responses[uname][sid].id;
      if (typeof rid === 'number' && rid > max) max = rid;
    }
  }
  return max + 1;
}

// GET /api/doctor/questionnaires - schema for rendering the forms
router.get('/questionnaires', (req, res) => {
  res.json({ questionnaires: QUESTIONNAIRES, order: ORDER });
});

// GET /api/doctor/cases
router.get('/cases', async (req, res) => {
  try {
    const { cases, sessions } = await loadData();
    const responses = await loadResponses();
    const mine = responses[req.session.user.username] || {};

    const result = cases.map(c => {
      const caseSessions = sessions.filter(s => s.case_uuid === c.case_uuid);
      let done = 0, inReview = 0, notHandled = 0;
      caseSessions.forEach(s => {
        const { status } = computeStatus(mine[s.id]);
        if (status === 'done') done++;
        else if (status === 'in_review') inReview++;
        else notHandled++;
      });
      return {
        case_uuid: c.case_uuid,
        title: c.title,
        sessionCount: caseSessions.length,
        progress: { done, inReview, notHandled }
      };
    });

    res.json({ cases: result });
  } catch (err) {
    console.error('[doctor] GET /cases failed:', err);
    res.status(500).json({ error: 'Failed to load cases' });
  }
});

// GET /api/doctor/cases/:caseUuid/sessions
router.get('/cases/:caseUuid/sessions', async (req, res) => {
  try {
    const { cases, sessions } = await loadData();
    const responses = await loadResponses();
    const mine = responses[req.session.user.username] || {};

    const caseInfo = cases.find(c => c.case_uuid === req.params.caseUuid);
    if (!caseInfo) return res.status(404).json({ error: 'Case not found' });

    const caseSessions = sessions
      .filter(s => s.case_uuid === req.params.caseUuid)
      .map(s => {
        const { status } = computeStatus(mine[s.id]);
        return {
          id: s.id,
          timestamp: s.timestamp,
          studentLabel: s.studentLabel,
          status
        };
      });

    res.json({ case: caseInfo, sessions: caseSessions });
  } catch (err) {
    console.error('[doctor] GET /cases/:caseUuid/sessions failed:', err);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// GET /api/doctor/sessions/:id
router.get('/sessions/:id', async (req, res) => {
  try {
    const { sessions, cases } = await loadData();
    const session = sessions.find(s => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const caseInfo = cases.find(c => c.case_uuid === session.case_uuid) || null;

    const responses = await loadResponses();
    const mine = (responses[req.session.user.username] || {})[session.id] || {};
    const statusInfo = computeStatus(mine);

    res.json({
      session: {
        id: session.id,
        case_uuid: session.case_uuid,
        title: session.title,
        timestamp: session.timestamp,
        studentLabel: session.studentLabel,
        messages: session.messages,
        studentDiagnosis: session.studentDiagnosis,
        correctDiagnosis: session.aiReview.correct_diagnosis
        // Note: the AI's score/feedback text and hints/duration are still
        // withheld from the reviewer until the relevant questionnaires are
        // complete, so the doctor's own judgment isn't anchored by them.
        // The correct/student diagnosis, however, is shown from the start,
        // since it's needed to score Diagnosis Accuracy in Questionnaire 2.
      },
      caseInfo,
      answers: {
        VP: mine.VP || null,
        SE: mine.SE || null,
        FE: mine.FE || null
      },
      status: statusInfo.status,
      feedbackUnlocked: statusInfo.feedbackUnlocked,
      aiReview: statusInfo.feedbackUnlocked ? session.aiReview : null,
      sessionMeta: statusInfo.feedbackUnlocked
        ? { hints_used: session.hints_used, chat_duration: session.chat_duration }
        : null
    });
  } catch (err) {
    console.error('[doctor] GET /sessions/:id failed:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// POST /api/doctor/sessions/:id/answers  { section, answers, openText }
router.post('/sessions/:id/answers', async (req, res) => {
  try {
    const { section, answers, openText } = req.body || {};
    if (!QUESTIONNAIRES[section]) {
      return res.status(400).json({ error: 'Invalid questionnaire section' });
    }

    const { sessions } = await loadData();
    const session = sessions.find(s => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Guard: FE cannot be saved until VP + SE are complete (feedback must be unlocked first).
    const responses = await loadResponses();
    const username = req.session.user.username;
    responses[username] = responses[username] || {};
    const record = responses[username][session.id] || {};

    // First time this doctor touches this session: assign a stable
    // reference id and record when the review began.
    if (typeof record.id !== 'number') {
      record.id = nextResponseId(responses);
      record.time_begin = new Date().toISOString();
    }

    if (section === 'FE') {
      const gate = computeStatus(record);
      if (!gate.feedbackUnlocked) {
        return res.status(409).json({ error: 'Complete Questionnaire 1 and 2 before Questionnaire 3' });
      }
    }

    // Sanitize: only accept known item ids, numeric values within valid option range.
    const def = QUESTIONNAIRES[section];
    const validIds = new Set(def.items.map(i => i.id));
    const cleanAnswers = {};
    if (answers && typeof answers === 'object') {
      for (const [k, v] of Object.entries(answers)) {
        if (validIds.has(k) && v !== null && v !== undefined && v !== '') {
          const num = Number(v);
          if (!Number.isNaN(num) && def.options.some(o => o.value === num)) {
            cleanAnswers[k] = num;
          }
        }
      }
    }

    record[section] = {
      answers: cleanAnswers,
      openText: def.openText ? String(openText || '').slice(0, 4000) : undefined,
      updatedAt: new Date().toISOString()
    };
    responses[username][session.id] = record;

    // Once every questionnaire is complete for the first time, stamp the
    // completion time so reviewer_duration (time_end - time_begin) reflects
    // how long the actual review took. Left untouched on later edits.
    const statusInfo = computeStatus(record);
    if (statusInfo.status === 'done' && !record.time_end) {
      record.time_end = new Date().toISOString();
    }

    await writeJson('responses.json', responses);

    res.json({
      ok: true,
      status: statusInfo.status,
      feedbackUnlocked: statusInfo.feedbackUnlocked,
      aiReview: statusInfo.feedbackUnlocked ? session.aiReview : null,
      sessionMeta: statusInfo.feedbackUnlocked
        ? { hints_used: session.hints_used, chat_duration: session.chat_duration }
        : null
    });
  } catch (err) {
    console.error('[doctor] failed to save answers:', err);
    res.status(500).json({ error: 'Failed to save answers' });
  }
});

module.exports = router;
