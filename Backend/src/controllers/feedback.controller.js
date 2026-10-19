const Feedback = require('../models/Feedback');
const Order = require('../models/Order');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { FEEDBACK_STATUS, MESSAGES, HTTP_STATUS } = require('../config/constants');
const { logAction } = require('../utils/audit');

/**

* @desc    Submit feedback for an order
* @route   POST /api/feedback
* @access  Private
*
* Frontend: feedback.html → Submit feedback
* Expected Body: { orderId, rating, comment, category }
* Response: { success, feedback }
*/
exports.submitFeedback = async (req, res) => {
  try {
    const { orderId, rating, comment, category, dishName } = req.body;

    // ✅ Validate rating (required)
    if (!rating) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Rating is required',
      });
    }

    // ✅ Validate rating
    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,

        error: 'Rating must be between 1 and 5',
      });
    }

    // ✅ Validate order if provided (feedback can also be given without an order)
    let orderRef = null;
    if (orderId) {
      const order = await Order.findOne({ orderId: orderId });
      if (!order) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: 'Order not found',
        });
      }
      orderRef = order._id;

      // ✅ Check if feedback already exists for this order
      const existingFeedback = await Feedback.findOne({
        orderId: orderRef,
        userId: req.user.id,
      });
      if (existingFeedback) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: 'Feedback already submitted for this order',
        });
      }
    }

    // ✅ Create feedback
    const feedback = await Feedback.create({
      userId: req.user.id,
      orderId: orderRef,
      rating: rating,
      comment: comment || '',
      category: category || 'Food Quality',
      dishName: dishName || '',
      status: FEEDBACK_STATUS.PENDING,
    });

    // ✅ Audit feedback submission
    await logAction({
      req,
      action: 'FEEDBACK_SUBMITTED',
      entityType: 'Feedback',
      entityId: String(feedback._id),
      description: `${req.user.name || 'Customer'} submitted ${rating}-star feedback (${category || 'Food Quality'})`,
    });

    // ✅ Real-time to admin dashboard
    try {
      const { emitSocketEvent } = require('../utils/socket');
      emitSocketEvent('admin', 'feedback:new', {
        id: feedback._id,
        userId: feedback.userId,
        rating: feedback.rating,
        comment: feedback.comment,
        category: feedback.category,
        dishName: feedback.dishName,
        status: feedback.status,
        createdAt: feedback.createdAt,
      });
    } catch (e) {
      console.warn('Socket emit failed for new feedback:', e.message);
    }

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Thank you for your feedback!',

      feedback: {
        id: feedback._id,
        rating: feedback.rating,
        comment: feedback.comment,
        category: feedback.category,
        dishName: feedback.dishName,
        status: feedback.status,
        createdAt: feedback.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Submit Feedback Error:', error);

    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get user's feedback
 * @route   GET /api/feedback/my
 * @access  Private
 *
 * Frontend: feedback.html → Show user's past feedback
 * Response: { success, count,

feedback: [...] }
*/
exports.getMyFeedback = async (req, res) => {
  try {
    const feedback = await Feedback.find({ userId: req.user.id })
      .populate('orderId', 'orderId customerName items totalAmount')
      .populate('replyBy', 'name role')
      .sort({ createdAt: -1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: feedback.length,
      feedback: feedback.map((fb) => ({
        id: fb._id,

        orderId: fb.orderId?.orderId || 'N/A',
        rating: fb.rating,
        comment: fb.comment,
        category: fb.category,
        dishName: fb.dishName,
        status: fb.status,
        isRead: fb.isRead,
        // The staff reply. This MUST be part of this payload: the customer
        // feedback page renders the reply straight off this list, so omitting
        // it here made every saved reply invisible to the customer.
        reply: fb.reply || '',
        repliedAt: fb.repliedAt || null,
        repliedBy: fb.replyBy
          ? { name: fb.replyBy.name, role: fb.replyBy.role }
          : null,
        createdAt: fb.createdAt,
      })),
    });
  } catch (error) {
    console.error('❌ Get My Feedback Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Get all feedback (Admin only)
* @route   GET /api/feedback
* @access  Private/Admin
*
* Frontend: admin/feedback.html → Load all feedback
* Query Params: status, rating, date
* Response: { success, count, feedback: [...] }

*/
exports.getAllFeedback = async (req, res) => {
  try {
    const { status, rating, date, search, limit = 50, page = 1 } = req.query;

    // ✅ Build filter
    let filter = {};
    if (status && status !== 'all') filter.status = status;
    if (rating) filter.rating = parseInt(rating);
    if (search && String(search).trim()) {
      const term = String(search).trim();
      filter.$or = [
        { comment: { $regex: term, $options: 'i' } },
        { category: { $regex: term, $options: 'i' } },
        { dishName: { $regex: term, $options: 'i' } },
      ];
    }
    if (date) filter.createdAt = { $regex: date };

    // ✅ Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // ✅ Execute query
    const feedback = await Feedback.find(filter)
      .populate('userId', 'name email phone role')
      .populate('orderId', 'orderId customerName')
      .populate('replyBy', 'name role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Feedback.countDocuments(filter);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: feedback.length,
      total: total,
      pages: Math.max(Math.ceil(total / parseInt(limit)), 1),
      page: parseInt(page),
      feedback: feedback.map((fb) => ({
        id: fb._id,
        user: fb.userId
          ? {
              name: fb.userId.name,
              email: fb.userId.email,
              phone: fb.userId.phone,
              role: fb.userId.role,
            }
          : null,
        orderId: fb.orderId?.orderId || 'N/A',
        customerName: fb.orderId?.customerName || 'N/A',
        rating: fb.rating,
        comment: fb.comment,
        category: fb.category,

        dishName: fb.dishName,
        status: fb.status,
        isRead: fb.isRead,
        // Carried on the list (not just the detail endpoint) so the admin
        // reply modal can pre-fill an existing reply instead of silently
        // overwriting it with a blank box.
        reply: fb.reply || '',
        repliedAt: fb.repliedAt || null,
        repliedBy: fb.replyBy ? { name: fb.replyBy.name, role: fb.replyBy.role } : null,
        createdAt: fb.createdAt,
      })),
    });
  } catch (error) {
    console.error('❌ Get All Feedback Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/* -------------------------------------------------------------------
 * Get single feedback by ID (Admin only)
 * ------------------------------------------------------------------- */
exports.getFeedbackById = async (req, res) => {
  try {
    const feedback = await Feedback.findById(req.params.id)
      .populate('userId', 'name email phone role')
      .populate('orderId', 'orderId customerName')
      .populate('replyBy', 'name role');
    if (!feedback) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Feedback not found' });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      feedback: {
        id: feedback._id,
        user: feedback.userId
          ? {
              name: feedback.userId.name,
              email: feedback.userId.email,
              phone: feedback.userId.phone,
              role: feedback.userId.role,
            }
          : null,
        orderId: feedback.orderId?.orderId || 'N/A',
        customerName: feedback.orderId?.customerName || 'N/A',
        rating: feedback.rating,
        comment: feedback.comment,
        category: feedback.category,
        dishName: feedback.dishName,
        status: feedback.status,
        reply: feedback.reply || '',
        repliedAt: feedback.repliedAt || null,
        repliedBy: feedback.replyBy ? { name: feedback.replyBy.name, role: feedback.replyBy.role } : null,
        createdAt: feedback.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Get Feedback By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Mark feedback as processed (RESOLVED / ARCHIVED) - Admin only
 * @route   PATCH /api/feedback/:id/status
 * @access  Private/Admin
 *
 * Frontend: admin/feedback.html → Mark processed / archive
 * Expected Body: { status: 'RESOLVED' | 'ARCHIVED' }
 * Response: { success, feedback }
 */
exports.updateFeedbackStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['RESOLVED', 'ARCHIVED'].includes(status)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'status must be RESOLVED or ARCHIVED',
      });
    }

    const feedback = await Feedback.findById(req.params.id);
    if (!feedback) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Feedback not found',
      });
    }

    feedback.status = status;
    feedback.processedAt = new Date();
    feedback.processedBy = req.user.id;

    await feedback.save();

    // Audit trail for the resolution action (no PII beyond the id/rating).
    const { logAction } = require('../utils/audit');
    await logAction({
      req,
      action: 'FEEDBACK_UPDATED',
      entityType: 'Feedback',
      entityId: String(feedback._id),
      description: `Feedback ${status === 'RESOLVED' ? 'marked as resolved' : 'archived'} (rating ${feedback.rating})`,
      result: 'SUCCESS',
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: status === 'RESOLVED' ? 'Feedback marked as processed' : 'Feedback archived',
      feedback: {
        id: feedback._id,
        status: feedback.status,
        processedAt: feedback.processedAt,
        isRead: feedback.isRead,
      },
    });
  } catch (error) {
    console.error('❌ Update Feedback Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Send a reply to customer feedback (manager/admin)
 * @route   PATCH /api/v1/feedback/:id/reply
 * @access  Private/Admin or Manager roles
 *
 * Without this route the admin/manager reply form (PATCH .../reply) 404'd,
 * and even if it had succeeded the reply was not persisted because the
 * Feedback schema had no `reply` field.
 */
exports.replyToFeedback = async (req, res) => {
  try {
    // `resolved` is the admin modal's "Mark as resolved" toggle. When omitted
    // it defaults to true, keeping the original auto-resolve-on-reply
    // behaviour; when explicitly false the reply is stored but the feedback
    // stays PENDING.
    const { reply, resolved } = req.body;
    const markResolved = resolved === undefined ? true : Boolean(resolved);

    if (!reply || typeof reply !== 'string' || !reply.trim()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Reply message is required',
      });
    }

    const feedback = await Feedback.findById(req.params.id);
    if (!feedback) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Feedback not found',
      });
    }

    feedback.reply = reply.trim();
    feedback.replyBy = req.user && (req.user.id || req.user._id) ? (req.user.id || req.user._id) : null;
    feedback.repliedAt = new Date();
    feedback.processedAt = new Date();
    feedback.processedBy = feedback.replyBy;
    feedback.isRead = true;
    if (markResolved && feedback.status === 'PENDING') {
      feedback.status = 'RESOLVED';
    }

    await feedback.save();

    const { logAction } = require('../utils/audit');
    await logAction({
      req,
      action: 'FEEDBACK_UPDATED',
      entityType: 'Feedback',
      entityId: String(feedback._id),
      description: `Reply sent to feedback (rating ${feedback.rating})`,
      result: 'SUCCESS',
    });

    // Tell the customer their reply landed. Without this the customer page
    // only ever learned about a new reply on a full page reload, because
    // nothing emitted the `notification:new` frame the feedback page listens
    // for. Best-effort: a notification failure must not fail the reply.
    try {
      const { notifyUser } = require('../utils/notification');
      await notifyUser(feedback.userId, {
        title: 'Reply to your feedback',
        message: `Our team replied to your feedback: "${feedback.reply}"`,
        type: 'system',
        link: '/src/pages/customer/feedback.html',
      });
    } catch (notifyError) {
      console.warn('Feedback reply notification failed:', notifyError.message);
    }

    // Direct feedback frame for the customer page, so the reply is rendered
    // the moment it is sent rather than after a notification round-trip.
    try {
      const { emitSocketEvent } = require('../utils/socket');
      emitSocketEvent(`user:${feedback.userId}`, 'feedback:reply', {
        id: String(feedback._id),
        reply: feedback.reply,
        repliedAt: feedback.repliedAt,
        status: feedback.status,
      });
    } catch (_) {
      /* realtime is best effort */
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Reply sent successfully',
      feedback: {
        id: feedback._id,
        reply: feedback.reply,
        repliedAt: feedback.repliedAt,
        status: feedback.status,
        isRead: feedback.isRead,
      },
    });
  } catch (error) {
    console.error('❌ Reply to Feedback Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Mark feedback as read (Admin only)
 * @route   PATCH /api/feedback/:id/read
 * @access  Private/Admin
 * Response: { success, feedback }
 */
exports.markFeedbackRead = async (req, res) => {
  try {
    const feedback = await Feedback.findByIdAndUpdate(req.params.id, { $set: { isRead: true } }, { new: true });
    if (!feedback) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Feedback not found',
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      feedback: { id: feedback._id, isRead: feedback.isRead },
    });
  } catch (error) {
    console.error('❌ Mark Feedback Read Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Delete feedback (Admin only)

* @route   DELETE /api/feedback/:id
* @access  Private/Admin
*
* Frontend: admin/feedback.html → Delete feedback
* Response: { success, message }
*/
exports.deleteFeedback = async (req, res) => {
  try {
    const feedback = await Feedback.findByIdAndDelete(req.params.id);

    if (!feedback) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Feedback not found',
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Feedback deleted successfully',
    });
  } catch (error) {
    console.error('❌ Delete Feedback Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Get feedback statistics (Admin only)
* @route   GET /api/feedback/stats
* @access  Private/Admin
*
* Frontend: admin/feedback.html → Metrics
* Response: { totalFeedback, pending, approved, averageRating, ratingDistribution }

*/
exports.getFeedbackStats = async (req, res) => {
  try {
    const totalFeedback = await Feedback.countDocuments();
    const pending = await Feedback.countDocuments({
      status: FEEDBACK_STATUS.PENDING,
    });
    const approved = await Feedback.countDocuments({
      status: FEEDBACK_STATUS.APPROVED,
    });
    const rejected = await Feedback.countDocuments({
      status: FEEDBACK_STATUS.REJECTED,
    });
    // New (not yet read) feedback - the workload number dashboards show as
    // "New Feedback". Server-sourced so it survives refresh for every device.
    const unread = await Feedback.countDocuments({ isRead: false });

    // ✅ Calculate average rating
    const allFeedback = await Feedback.find();
    const ratings = allFeedback.map((fb) => fb.rating);
    const averageRating = ratings.length > 0 ? (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(1) : 0;

    // ✅ Rating distribution
    const ratingDistribution = {
      1: allFeedback.filter((fb) => fb.rating === 1).length,
      2: allFeedback.filter((fb) => fb.rating === 2).length,
      3: allFeedback.filter((fb) => fb.rating === 3).length,

      4: allFeedback.filter((fb) => fb.rating === 4).length,
      5: allFeedback.filter((fb) => fb.rating === 5).length,
    };

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        totalFeedback,
        pending,
        approved,
        rejected,
        unread,
        averageRating: parseFloat(averageRating),
        ratingDistribution,
      },
    });
  } catch (error) {
    console.error('❌ Get Feedback Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};
