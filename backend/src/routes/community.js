const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/community/posts - feed, optionally filtered by type/status
router.get('/posts', async (req, res) => {
  const { type, status } = req.query;
  const conditions = [];
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
              u.first_name AS author_first_name,
              (SELECT COUNT(*)::int FROM community_comments cm WHERE cm.post_id = p.id) AS comment_count
       FROM community_posts p
       JOIN cases c ON c.id = p.case_id
       JOIN users u ON u.id = p.user_id
       ${where}
       ORDER BY p.created_at DESC`,
      params
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
      commentCount: r.comment_count,
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

// GET /api/community/posts/:id - post detail with case data and comment thread
router.get('/posts/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const postResult = await pool.query(
      `SELECT p.id, p.case_id, p.note, p.status, p.anonymous, p.user_id, p.created_at,
              c.data AS case_data,
              u.first_name AS author_first_name
       FROM community_posts p
       JOIN cases c ON c.id = p.case_id
       JOIN users u ON u.id = p.user_id
       WHERE p.id = $1`,
      [id]
    );
    if (!postResult.rows.length) {
      return res.status(404).json({ error: 'Post not found' });
    }
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
      [id, req.user.id]
    );

    res.json({
      id: row.id,
      caseId: row.case_id,
      case: row.case_data,
      note: row.note,
      status: row.status,
      anonymous: row.anonymous,
      author: row.anonymous ? 'Anonymous' : row.author_first_name || 'Someone',
      isOwner: row.user_id === req.user.id,
      createdAt: row.created_at,
      comments: commentsResult.rows.map(c => ({
        id: c.id,
        body: c.body,
        isAccepted: c.is_accepted,
        author: c.anonymous ? 'Anonymous' : c.author_first_name || 'Someone',
        isOwner: c.user_id === req.user.id,
        voteCount: c.vote_count,
        viewerVoted: c.viewer_voted,
        createdAt: c.created_at
      }))
    });
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
    const existing = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Post not found' });
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

// POST /api/community/posts/:id/comments - reply to a post
router.post('/posts/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { body, anonymous } = req.body;
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Comment body is required' });
  }

  try {
    const postExists = await pool.query('SELECT id FROM community_posts WHERE id = $1', [id]);
    if (!postExists.rows.length) {
      return res.status(404).json({ error: 'Post not found' });
    }

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
    const commentExists = await pool.query('SELECT id FROM community_comments WHERE id = $1', [id]);
    if (!commentExists.rows.length) {
      return res.status(404).json({ error: 'Comment not found' });
    }

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

module.exports = router;
