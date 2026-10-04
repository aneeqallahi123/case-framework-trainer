const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateSolvedFramework } = require('../lib/solvedFramework');

const router = express.Router();
router.use(requireAuth);

// Expert-framework entries (community_posts.kind = 'expert') are locked until the viewer has saved a drill on that
// case. Every route that reads or writes one goes through this check; hiding it in the UI alone would leak it.
async function hasAttempted(userId, caseId) {
  const r = await pool.query('SELECT 1 FROM drill_results WHERE user_id = $1 AND case_id = $2 LIMIT 1', [userId, caseId]);
  return r.rows.length > 0;
}

// -> { found, allowed, caseId }. Student posts are always allowed.
async function postAccess(postId, userId) {
  const r = await pool.query('SELECT kind, case_id FROM community_posts WHERE id = $1', [postId]);
  if (!r.rows.length) return { found: false };
  const { kind, case_id: caseId } = r.rows[0];
  if (kind !== 'expert') return { found: true, allowed: true, caseId };
  return { found: true, allowed: await hasAttempted(userId, caseId), caseId };
}

const LOCKED = { error: 'Locked until you have attempted this case', locked: true };

// GET /api/community/posts - feed, optionally filtered by type/status
router.get('/posts', async (req, res) => {
  const { type, status } = req.query;
  const conditions = [`p.kind = 'post'`];
  const params = [];

  if (type) {
    params.push(type);
    conditions.push(`c.type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT p.id, p.case_id, p.note, p.status, p.anonymous, p.created_at,
              c.title AS case_title, c.type AS case_type, c.source AS case_source,
              u.first_name AS author_first_name, u.id AS author_id,
              (SELECT COUNT(*)::int FROM community_comments cm WHERE cm.post_id = p.id) AS comment_count,
              (SELECT COUNT(*)::int FROM community_post_votes pv WHERE pv.post_id = p.id) AS vote_count,
              EXISTS(SELECT 1 FROM community_post_votes pv WHERE pv.post_id = p.id AND pv.user_id = $${params.length + 1}) AS viewer_voted
       FROM community_posts p
       JOIN cases c ON c.id = p.case_id
       JOIN users u ON u.id = p.user_id
       ${where}
       ORDER BY p.created_at DESC`,
      [...params, req.user.id]
    );

    const posts = result.rows.map(r => ({
      id: r.id,
      caseId: r.case_id,
      caseTitle: r.case_title,
      caseType: r.case_type,
      caseSource: r.case_source,
      note: r.note,
      status: r.status,
      author: r.anonymous ? 'Anonymous' : r.author_first_name || 'Someone',
      authorId: r.anonymous ? null : r.author_id,
      commentCount: r.comment_count,
      voteCount: r.vote_count,
      viewerVoted: r.viewer_voted,
      createdAt: r.created_at
    }));

    res.json(posts);
  } catch (err) {
    console.error('Get community posts error:', err);
    res.status(500).json({ error: 'Could not fetch community posts' });
  }
});

// POST /api/community/posts - share a case you're confused about
router.post('/posts', async (req, res) => {
  const { caseId, note, anonymous } = req.body;
  if (!caseId) {
    return res.status(400).json({ error: 'Case ID is required' });
  }

  try {
    const caseExists = await pool.query('SELECT id FROM cases WHERE id = $1', [caseId]);
    if (!caseExists.rows.length) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const result = await pool.query(
      `INSERT INTO community_posts (case_id, user_id, note, anonymous)
       VALUES ($1, $2, $3, $4)
       RETURNING id, case_id, note, status, anonymous, created_at`,
      [caseId, req.user.id, note || '', !!anonymous]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create community post error:', err);
    res.status(500).json({ error: 'Could not create community post' });
  }
});

// Post detail with case data and comment thread. Returns null if the post does not exist.
async function loadPostDetail(id, viewerId) {
  const postResult = await pool.query(
    `SELECT p.id, p.case_id, p.note, p.status, p.anonymous, p.user_id, p.created_at, p.kind,
            c.data AS case_data,
            u.first_name AS author_first_name,
            (SELECT COUNT(*)::int FROM community_post_votes pv WHERE pv.post_id = p.id) AS vote_count,
            EXISTS(SELECT 1 FROM community_post_votes pv WHERE pv.post_id = p.id AND pv.user_id = $2) AS viewer_voted
     FROM community_posts p
     JOIN cases c ON c.id = p.case_id
     JOIN users u ON u.id = p.user_id
     WHERE p.id = $1`,
    [id, viewerId]
  );
  if (!postResult.rows.length) return null;
  const row = postResult.rows[0];

  const commentsResult = await pool.query(
    `SELECT cm.id, cm.body, cm.is_accepted, cm.anonymous, cm.user_id, cm.created_at,
            u.first_name AS author_first_name,
            (SELECT COUNT(*)::int FROM community_comment_votes v WHERE v.comment_id = cm.id) AS vote_count,
            EXISTS(SELECT 1 FROM community_comment_votes v WHERE v.comment_id = cm.id AND v.user_id = $2) AS viewer_voted
     FROM community_comments cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.post_id = $1
     ORDER BY cm.is_accepted DESC, vote_count DESC, cm.created_at ASC`,
    [id, viewerId]
  );

  return {
    id: row.id,
    caseId: row.case_id,
    case: row.case_data,
    kind: row.kind,
    note: row.note,
    status: row.status,
    anonymous: row.anonymous,
    author: row.anonymous ? 'Anonymous' : row.author_first_name || 'Someone',
    authorId: row.anonymous ? null : row.user_id,
    isOwner: row.user_id === viewerId,
    voteCount: row.vote_count,
    viewerVoted: row.viewer_voted,
    createdAt: row.created_at,
    comments: commentsResult.rows.map(c => ({
      id: c.id,
      body: c.body,
      isAccepted: c.is_accepted,
      author: c.anonymous ? 'Anonymous' : c.author_first_name || 'Someone',
      authorId: c.anonymous ? null : c.user_id,
      isOwner: c.user_id === viewerId,
      voteCount: c.vote_count,
      viewerVoted: c.viewer_voted,
      createdAt: c.created_at
    }))
  };
}

// GET /api/community/posts/:id - post detail with case data and comment thread
router.get('/posts/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const access = await postAccess(id, req.user.id);
    if (!access.found) return res.status(404).json({ error: 'Post not found' });
    if (!access.allowed) return res.status(403).json({ ...LOCKED, caseId: access.caseId });
    res.json(await loadPostDetail(id, req.user.id));
  } catch (err) {
    console.error('Get community post error:', err);
    res.status(500).json({ error: 'Could not fetch post' });
  }
});

// PATCH /api/community/posts/:id - mark resolved/open (owner only)
router.patch('/posts/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['open', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open or resolved' });
  }

  try {
    const existing = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (existing.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only update your own posts' });
    }

    const result = await pool.query(
      `UPDATE community_posts SET status = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, status`,
      [status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update community post error:', err);
    res.status(500).json({ error: 'Could not update post' });
  }
});

// DELETE /api/community/posts/:id - delete a post (owner only)
router.delete('/posts/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await pool.query('SELECT user_id, kind FROM community_posts WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (existing.rows[0].kind === 'expert') {
      return res.status(403).json({ error: 'Expert entries are managed by admins' });
    }
    if (existing.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own posts' });
    }

    await pool.query('DELETE FROM community_posts WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete community post error:', err);
    res.status(500).json({ error: 'Could not delete post' });
  }
});

// POST /api/community/posts/:id/vote - toggle upvote on a post
router.post('/posts/:id/vote', async (req, res) => {
  const { id } = req.params;

  try {
    const access = await postAccess(id, req.user.id);
    if (!access.found) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (!access.allowed) return res.status(403).json({ ...LOCKED, caseId: access.caseId });

    const existing = await pool.query(
      'SELECT 1 FROM community_post_votes WHERE post_id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length) {
      await pool.query('DELETE FROM community_post_votes WHERE post_id = $1 AND user_id = $2', [id, req.user.id]);
    } else {
      await pool.query('INSERT INTO community_post_votes (post_id, user_id) VALUES ($1, $2)', [id, req.user.id]);
    }

    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM community_post_votes WHERE post_id = $1',
      [id]
    );
    res.json({ voteCount: countResult.rows[0].count, viewerVoted: !existing.rows.length });
  } catch (err) {
    console.error('Vote post error:', err);
    res.status(500).json({ error: 'Could not register vote' });
  }
});

// POST /api/community/posts/:id/comments - reply to a post
router.post('/posts/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { body, anonymous } = req.body;
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Comment body is required' });
  }

  try {
    const access = await postAccess(id, req.user.id);
    if (!access.found) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (!access.allowed) return res.status(403).json({ ...LOCKED, caseId: access.caseId });

    const result = await pool.query(
      `INSERT INTO community_comments (post_id, user_id, body, anonymous)
       VALUES ($1, $2, $3, $4)
       RETURNING id, post_id, body, is_accepted, anonymous, created_at`,
      [id, req.user.id, body.trim(), !!anonymous]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create comment error:', err);
    res.status(500).json({ error: 'Could not add comment' });
  }
});

// POST /api/community/comments/:id/vote - toggle a helpful vote
router.post('/comments/:id/vote', async (req, res) => {
  const { id } = req.params;

  try {
    const commentExists = await pool.query('SELECT post_id FROM community_comments WHERE id = $1', [id]);
    if (!commentExists.rows.length) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    const access = await postAccess(commentExists.rows[0].post_id, req.user.id);
    if (!access.allowed) return res.status(403).json({ ...LOCKED, caseId: access.caseId });

    const existingVote = await pool.query(
      'SELECT 1 FROM community_comment_votes WHERE comment_id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (existingVote.rows.length) {
      await pool.query(
        'DELETE FROM community_comment_votes WHERE comment_id = $1 AND user_id = $2',
        [id, req.user.id]
      );
    } else {
      await pool.query(
        'INSERT INTO community_comment_votes (comment_id, user_id) VALUES ($1, $2)',
        [id, req.user.id]
      );
    }

    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM community_comment_votes WHERE comment_id = $1',
      [id]
    );
    res.json({ voteCount: countResult.rows[0].count, viewerVoted: !existingVote.rows.length });
  } catch (err) {
    console.error('Vote comment error:', err);
    res.status(500).json({ error: 'Could not register vote' });
  }
});

// POST /api/community/comments/:id/accept - mark a comment as the accepted answer (post owner only)
router.post('/comments/:id/accept', async (req, res) => {
  const { id } = req.params;

  try {
    const commentResult = await pool.query(
      `SELECT cm.post_id, p.user_id AS post_owner_id
       FROM community_comments cm
       JOIN community_posts p ON p.id = cm.post_id
       WHERE cm.id = $1`,
      [id]
    );
    if (!commentResult.rows.length) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    const { post_id: postId, post_owner_id: postOwnerId } = commentResult.rows[0];
    if (postOwnerId !== req.user.id) {
      return res.status(403).json({ error: 'Only the post author can accept a comment' });
    }

    await pool.query('UPDATE community_comments SET is_accepted = false WHERE post_id = $1', [postId]);
    await pool.query('UPDATE community_comments SET is_accepted = true WHERE id = $1', [id]);
    await pool.query(`UPDATE community_posts SET status = 'resolved', updated_at = NOW() WHERE id = $1`, [postId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Accept comment error:', err);
    res.status(500).json({ error: 'Could not accept comment' });
  }
});

// ─── Expert frameworks ───────────────────────────────────────────────────────

// GET /api/community/experts - every approved expert framework, with whether the viewer has unlocked it.
// Bodies are never returned here.
router.get('/experts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sf.id, sf.case_id, sf.framework->>'shape' AS shape, c.title, c.type, c.source,
              u.id AS expert_id, u.first_name AS expert_name,
              EXISTS(SELECT 1 FROM drill_results d WHERE d.user_id = $1 AND d.case_id = sf.case_id) AS unlocked,
              (SELECT COUNT(*)::int FROM community_comments cm JOIN community_posts p ON p.id = cm.post_id
               WHERE p.solved_framework_id = sf.id) AS comment_count
       FROM solved_frameworks sf
       JOIN cases c ON c.id = sf.case_id
       JOIN users u ON u.id = sf.creator_id
       WHERE sf.status = 'approved' AND sf.framework ? 'shape'
       ORDER BY c.title, sf.id`,
      [req.user.id]
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      caseId: r.case_id,
      caseTitle: r.title,
      caseType: r.type,
      caseSource: r.source,
      shape: r.shape,
      expert: { id: r.expert_id, name: r.expert_name || 'Expert' },
      unlocked: r.unlocked,
      commentCount: r.comment_count
    })));
  } catch (err) {
    console.error('List experts error:', err);
    res.status(500).json({ error: 'Could not fetch expert frameworks' });
  }
});

// GET /api/community/experts/:id - the framework and its discussion thread. 403 until the viewer has attempted the case.
router.get('/experts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const sf = await pool.query(
      `SELECT sf.id, sf.case_id, sf.framework, sf.creator_id, c.title, u.first_name AS expert_name
       FROM solved_frameworks sf JOIN cases c ON c.id = sf.case_id JOIN users u ON u.id = sf.creator_id
       WHERE sf.id = $1 AND sf.status = 'approved'`,
      [id]
    );
    const checked = sf.rows.length ? validateSolvedFramework(sf.rows[0].framework) : null;
    if (!checked || !checked.ok) return res.status(404).json({ error: 'Not found' });
    const row = sf.rows[0];

    if (!(await hasAttempted(req.user.id, row.case_id))) {
      return res.status(403).json({ ...LOCKED, caseId: row.case_id, caseTitle: row.title });
    }

    // The discussion thread is created the first time anyone unlocks the entry.
    await pool.query(
      `INSERT INTO community_posts (case_id, user_id, note, kind, solved_framework_id)
       VALUES ($1, $2, '', 'expert', $3)
       ON CONFLICT (solved_framework_id) WHERE solved_framework_id IS NOT NULL DO NOTHING`,
      [row.case_id, row.creator_id, id]
    );
    const post = await pool.query('SELECT id FROM community_posts WHERE solved_framework_id = $1', [id]);
    const detail = await loadPostDetail(post.rows[0].id, req.user.id);

    res.json({
      ...detail,
      solvedFrameworkId: id,
      framework: checked.value,
      expert: { id: row.creator_id, name: row.expert_name || 'Expert' }
    });
  } catch (err) {
    console.error('Get expert framework error:', err);
    res.status(500).json({ error: 'Could not fetch expert framework' });
  }
});

// ─── Members ────────────────────────────────────────────────────────────────

// GET /api/community/members - list all members with activity stats
router.get('/members', async (req, res) => {
  try {
    // Check if the viewing user has stats visibility enabled
    const viewerResult = await pool.query('SELECT show_stats FROM users WHERE id = $1', [req.user.id]);
    const viewerCanSeeStats = viewerResult.rows[0]?.show_stats !== false;

    const result = await pool.query(
      `SELECT u.id, u.first_name, u.created_at, u.show_stats,
              (SELECT COUNT(*)::int FROM community_posts p WHERE p.user_id = u.id AND p.anonymous = false AND p.kind = 'post') AS post_count,
              (SELECT COUNT(*)::int FROM community_comments cm JOIN community_posts p ON p.id = cm.post_id
               WHERE cm.user_id = u.id AND cm.anonymous = false AND p.kind = 'post') AS comment_count,
              (SELECT COUNT(*)::int FROM community_comments cm
               JOIN community_posts p ON p.id = cm.post_id
               WHERE cm.user_id = u.id AND cm.is_accepted = true AND cm.anonymous = false AND p.kind = 'post') AS accepted_count,
              (SELECT COUNT(*)::int FROM solved_frameworks sf WHERE sf.creator_id = u.id AND sf.status = 'approved' AND sf.framework ? 'shape') AS solved_count,
              (SELECT COUNT(*)::int FROM drill_results dr WHERE dr.user_id = u.id) AS case_count,
              (SELECT ROUND(AVG(dr.score))::int FROM drill_results dr WHERE dr.user_id = u.id) AS avg_score_pct
       FROM users u
       ORDER BY post_count DESC, comment_count DESC, u.first_name ASC`
    );

    const members = result.rows.map(r => {
      const base = {
        id: r.id,
        name: r.first_name || 'Member',
        postCount: r.post_count,
        commentCount: r.comment_count,
        acceptedCount: r.accepted_count,
        solvedCount: r.solved_count,
        joinedAt: r.created_at
      };
      if (!viewerCanSeeStats) {
        base.statsLocked = 'viewer';
      } else if (!r.show_stats) {
        base.statsLocked = 'member';
      } else {
        base.caseCount = r.case_count;
        base.avgScorePct = r.avg_score_pct;
      }
      return base;
    });

    res.json({ viewerCanSeeStats, members });
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ error: 'Could not fetch members' });
  }
});

// GET /api/community/members/:id - member profile with their public activity
router.get('/members/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const viewerResult = await pool.query('SELECT show_stats FROM users WHERE id = $1', [req.user.id]);
    const viewerCanSeeStats = viewerResult.rows[0]?.show_stats !== false;

    const userResult = await pool.query(
      `SELECT u.id, u.first_name, u.created_at, u.show_stats,
              (SELECT COUNT(*)::int FROM drill_results dr WHERE dr.user_id = u.id) AS case_count,
              (SELECT ROUND(AVG(dr.score))::int FROM drill_results dr WHERE dr.user_id = u.id) AS avg_score_pct,
              (SELECT COUNT(*)::int FROM solved_frameworks sf WHERE sf.creator_id = u.id AND sf.status = 'approved' AND sf.framework ? 'shape') AS solved_count
       FROM users u WHERE u.id = $1`,
      [id]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const user = userResult.rows[0];

    const postsResult = await pool.query(
      `SELECT p.id, p.note, p.status, p.created_at,
              c.title AS case_title, c.type AS case_type, c.source AS case_source,
              (SELECT COUNT(*)::int FROM community_comments cm WHERE cm.post_id = p.id) AS comment_count,
              (SELECT COUNT(*)::int FROM community_post_votes pv WHERE pv.post_id = p.id) AS vote_count
       FROM community_posts p
       JOIN cases c ON c.id = p.case_id
       WHERE p.user_id = $1 AND p.anonymous = false AND p.kind = 'post'
       ORDER BY p.created_at DESC`,
      [id]
    );

    const commentsResult = await pool.query(
      `SELECT cm.id, cm.body, cm.is_accepted, cm.created_at,
              c.title AS case_title,
              p.id AS post_id,
              (SELECT COUNT(*)::int FROM community_comment_votes v WHERE v.comment_id = cm.id) AS vote_count
       FROM community_comments cm
       JOIN community_posts p ON p.id = cm.post_id
       JOIN cases c ON c.id = p.case_id
       WHERE cm.user_id = $1 AND cm.anonymous = false AND p.kind = 'post'
       ORDER BY cm.created_at DESC
       LIMIT 20`,
      [id]
    );

    const statsInfo = {};
    if (!viewerCanSeeStats) {
      statsInfo.statsLocked = 'viewer';
    } else if (!user.show_stats) {
      statsInfo.statsLocked = 'member';
    } else {
      statsInfo.caseCount = user.case_count;
      statsInfo.avgScorePct = user.avg_score_pct;
    }

    res.json({
      id: user.id,
      name: user.first_name || 'Member',
      joinedAt: user.created_at,
      solvedCount: user.solved_count,
      isMe: user.id === req.user.id,
      viewerCanSeeStats,
      ...statsInfo,
      posts: postsResult.rows.map(p => ({
        id: p.id,
        note: p.note,
        status: p.status,
        caseTitle: p.case_title,
        caseType: p.case_type,
        caseSource: p.case_source,
        commentCount: p.comment_count,
        voteCount: p.vote_count,
        createdAt: p.created_at
      })),
      comments: commentsResult.rows.map(c => ({
        id: c.id,
        body: c.body,
        isAccepted: c.is_accepted,
        caseTitle: c.case_title,
        postId: c.post_id,
        voteCount: c.vote_count,
        createdAt: c.created_at
      }))
    });
  } catch (err) {
    console.error('Get member profile error:', err);
    res.status(500).json({ error: 'Could not fetch member profile' });
  }
});

// ─── Direct Messages ─────────────────────────────────────────────────────────

// GET /api/community/conversations - list user's conversations
router.get('/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dc.id, dc.updated_at,
              CASE WHEN dc.user1_id = $1 THEN dc.user2_id ELSE dc.user1_id END AS other_user_id,
              CASE WHEN dc.user1_id = $1 THEN u2.first_name ELSE u1.first_name END AS other_name,
              (SELECT dm.body FROM direct_messages dm WHERE dm.conversation_id = dc.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message,
              (SELECT dm.created_at FROM direct_messages dm WHERE dm.conversation_id = dc.id ORDER BY dm.created_at DESC LIMIT 1) AS last_message_at,
              (SELECT COUNT(*)::int FROM direct_messages dm WHERE dm.conversation_id = dc.id AND dm.sender_id != $1 AND dm.read_at IS NULL) AS unread_count
       FROM direct_conversations dc
       JOIN users u1 ON u1.id = dc.user1_id
       JOIN users u2 ON u2.id = dc.user2_id
       WHERE dc.user1_id = $1 OR dc.user2_id = $1
       ORDER BY dc.updated_at DESC`,
      [req.user.id]
    );

    res.json(result.rows.map(r => ({
      id: r.id,
      otherUserId: r.other_user_id,
      otherName: r.other_name || 'Member',
      lastMessage: r.last_message,
      lastMessageAt: r.last_message_at,
      unreadCount: r.unread_count,
      updatedAt: r.updated_at
    })));
  } catch (err) {
    console.error('Get conversations error:', err);
    res.status(500).json({ error: 'Could not fetch conversations' });
  }
});

// GET /api/community/conversations/unread-count - total unread across all conversations
router.get('/conversations/unread-count', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM direct_messages dm
       JOIN direct_conversations dc ON dc.id = dm.conversation_id
       WHERE (dc.user1_id = $1 OR dc.user2_id = $1)
         AND dm.sender_id != $1
         AND dm.read_at IS NULL`,
      [req.user.id]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error('Unread count error:', err);
    res.status(500).json({ error: 'Could not fetch unread count' });
  }
});

// POST /api/community/conversations - start or find a conversation with another user
router.post('/conversations', async (req, res) => {
  const { userId } = req.body;
  if (!userId || userId === req.user.id) {
    return res.status(400).json({ error: 'Invalid user' });
  }

  try {
    const userCheck = await pool.query('SELECT id, first_name FROM users WHERE id = $1', [userId]);
    if (!userCheck.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existing = await pool.query(
      `SELECT id FROM direct_conversations
       WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)`,
      [req.user.id, userId]
    );

    if (existing.rows.length) {
      return res.json({ id: existing.rows[0].id, existed: true });
    }

    const result = await pool.query(
      `INSERT INTO direct_conversations (user1_id, user2_id) VALUES ($1, $2) RETURNING id`,
      [req.user.id, userId]
    );

    res.status(201).json({ id: result.rows[0].id, existed: false });
  } catch (err) {
    console.error('Start conversation error:', err);
    res.status(500).json({ error: 'Could not start conversation' });
  }
});

// GET /api/community/conversations/:id/messages - get messages + mark incoming as read
router.get('/conversations/:id/messages', async (req, res) => {
  const { id } = req.params;

  try {
    const convCheck = await pool.query(
      'SELECT id, user1_id, user2_id FROM direct_conversations WHERE id = $1',
      [id]
    );
    if (!convCheck.rows.length) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = convCheck.rows[0];
    if (conv.user1_id !== req.user.id && conv.user2_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Mark incoming messages as read
    await pool.query(
      `UPDATE direct_messages SET read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL`,
      [id, req.user.id]
    );

    const otherUserId = conv.user1_id === req.user.id ? conv.user2_id : conv.user1_id;
    const otherUser = await pool.query('SELECT first_name FROM users WHERE id = $1', [otherUserId]);

    const messages = await pool.query(
      `SELECT dm.id, dm.body, dm.sender_id, dm.read_at, dm.created_at,
              u.first_name AS sender_name
       FROM direct_messages dm
       JOIN users u ON u.id = dm.sender_id
       WHERE dm.conversation_id = $1
       ORDER BY dm.created_at ASC`,
      [id]
    );

    res.json({
      conversationId: id,
      otherUserId,
      otherName: otherUser.rows[0]?.first_name || 'Member',
      messages: messages.rows.map(m => ({
        id: m.id,
        body: m.body,
        senderId: m.sender_id,
        senderName: m.sender_name,
        isMe: m.sender_id === req.user.id,
        readAt: m.read_at,
        createdAt: m.created_at
      }))
    });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Could not fetch messages' });
  }
});

// POST /api/community/conversations/:id/messages - send a message
router.post('/conversations/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { body } = req.body;
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Message body is required' });
  }

  try {
    const convCheck = await pool.query(
      'SELECT id, user1_id, user2_id FROM direct_conversations WHERE id = $1',
      [id]
    );
    if (!convCheck.rows.length) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = convCheck.rows[0];
    if (conv.user1_id !== req.user.id && conv.user2_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, sender_id, created_at`,
      [id, req.user.id, body.trim()]
    );

    await pool.query(
      'UPDATE direct_conversations SET updated_at = NOW() WHERE id = $1',
      [id]
    );

    const msg = result.rows[0];
    res.status(201).json({
      id: msg.id,
      body: msg.body,
      senderId: msg.sender_id,
      isMe: true,
      createdAt: msg.created_at
    });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Could not send message' });
  }
});

module.exports = router;
