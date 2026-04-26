import sql from "../configs/db.js";

export const getUserCreations = async (req, res) => {
  try {
    const { userId } = req.auth();

    const creations = await sql`
      SELECT * FROM creations
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;

    res.json({ success: true, creations });

  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

export const getPublishedCreations = async (req, res) => {
  try {
    const creations = await sql`
      SELECT * FROM creations
      WHERE publish = true
      ORDER BY created_at DESC
    `;

    res.json({ success: true, creations });

  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};

export const toggleLikeCreation = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { id } = req.body;

    const [creation] = await sql`
      SELECT * FROM creations WHERE id = ${id}
    `;

    const likes = creation.likes || [];
    const user = userId.toString();

    let updated = likes.includes(user)
      ? likes.filter(u => u !== user)
      : [...likes, user];

    await sql`
      UPDATE creations SET likes = ${updated} WHERE id = ${id}
    `;

    res.json({ success: true });

  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};