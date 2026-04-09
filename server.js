import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { clerkMiddleware, getAuth } from '@clerk/express'

const app = express();

app.use(cors());
app.use(express.json());
app.use(clerkMiddleware())

app.get('/', (req, res) =>res.send('Server is Live!'));

/** Replaces deprecated requireAuth(): reject requests with no signed-in user. */
function ensureAuthenticated(req, res, next) {
  const { userId } = getAuth(req)
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

app.use(ensureAuthenticated)

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {console.log(`Server is running on port ${PORT}`)});
export default app;

