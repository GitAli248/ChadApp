# Chadapp

A real-time chat application built with vanilla JavaScript and Supabase.

## Stack

- **Frontend**: Vanilla JS, CSS, HTML — no framework
- **Backend**: Supabase (PostgreSQL, Auth, Realtime)
- **Auth**: Supabase Auth (email/password)
- **Hosting**: Static files (Vercel-ready via `vercel.json`)

## Features

- Email/password signup and login
- One-on-one real-time messaging
- Message reply, forward, and delete
- Emoji picker
- Chat search and clear
- User blocking (two-way)
- Status presets: Online, Away, Busy, Invisible
- Online presence indicators with status colors
- Profile editing (name, email, age, gender, avatar)
- Avatar upload with client-side compression
- Chat requests (discover and request users)
- Conversation pin/favorites and mute
- Multi-language: English, Spanish, Hindi
- Dark/light theme
- Session management (active devices)

## Supabase Setup

Create a Supabase project and run the following SQL in the SQL Editor to create the required tables and RLS policies:

```sql
-- Profiles (extends auth.users)
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT DEFAULT '',
  age TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  status TEXT DEFAULT 'Online',
  allow_requests BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations
CREATE TABLE conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shared_id UUID,
  user_id UUID REFERENCES profiles(id) NOT NULL,
  other_user_id UUID REFERENCES profiles(id) NOT NULL,
  pinned BOOLEAN DEFAULT FALSE,
  muted BOOLEAN DEFAULT FALSE,
  unread INTEGER DEFAULT 0,
  last_msg TEXT DEFAULT '',
  last_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shared_id UUID,
  sender_id UUID REFERENCES profiles(id) NOT NULL,
  text TEXT NOT NULL,
  reply_to JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Blocked Users
CREATE TABLE blocked_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) NOT NULL,
  blocked_id UUID REFERENCES profiles(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, blocked_id)
);

-- Contacts
CREATE TABLE contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) NOT NULL,
  contact_id UUID REFERENCES profiles(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, contact_id)
);

-- Chat Requests
CREATE TABLE chat_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_user_id UUID REFERENCES profiles(id) NOT NULL,
  to_user_id UUID REFERENCES profiles(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_requests ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Anyone can read profiles" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Conversations policies
CREATE POLICY "Users can read own conversations" ON conversations FOR SELECT USING (auth.uid() = user_id OR auth.uid() = other_user_id);
CREATE POLICY "Users can create conversations" ON conversations FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.uid() = other_user_id);
CREATE POLICY "Users can update own conversations" ON conversations FOR UPDATE USING (auth.uid() = user_id OR auth.uid() = other_user_id);
CREATE POLICY "Users can delete own conversations" ON conversations FOR DELETE USING (auth.uid() = user_id);

-- Messages policies
CREATE POLICY "Users can read messages" ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversations WHERE shared_id = messages.shared_id AND (user_id = auth.uid() OR other_user_id = auth.uid()))
);
CREATE POLICY "Users can insert messages" ON messages FOR INSERT WITH CHECK (
  sender_id = auth.uid() AND EXISTS (SELECT 1 FROM conversations WHERE shared_id = messages.shared_id AND (user_id = auth.uid() OR other_user_id = auth.uid()))
);

-- Blocked users policies
CREATE POLICY "Users can read own blocks" ON blocked_users FOR SELECT USING (auth.uid() = user_id OR auth.uid() = blocked_id);
CREATE POLICY "Users can manage blocks" ON blocked_users FOR ALL USING (auth.uid() = user_id);

-- Contacts policies
CREATE POLICY "Users can read own contacts" ON contacts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can manage contacts" ON contacts FOR ALL USING (auth.uid() = user_id);

-- Chat Requests policies
CREATE POLICY "Anyone can insert chat requests" ON chat_requests FOR INSERT WITH CHECK (auth.uid() = from_user_id);
CREATE POLICY "Users can read own chat requests" ON chat_requests FOR SELECT USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);
CREATE POLICY "Users can delete own chat requests" ON chat_requests FOR DELETE USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
```

After running the SQL, enable **Realtime** for the `messages` table in the Supabase dashboard under Database > Replication.

## Configuration

Rename or edit `config.js` with your Supabase project credentials:

```js
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
```

Both values are found in Supabase Dashboard > Settings > API.

## Deployment

### Vercel

The project includes a `vercel.json` for SPA routing. Connect your repo to Vercel — it will detect the static file setup automatically.

### Any static host

Upload these files to any static file server or CDN:

```
index.html
styles.css
app.js
local-db.js
config.js
favicon.svg
manifest.json
```

## Architecture

### Data flow

Messages are inserted into Supabase and distributed to connected clients via Supabase Realtime subscriptions. The `local-db.js` file wraps the Supabase JS client with a chainable query builder that mirrors the old mock API for backward compatibility. Online presence is handled through Supabase Realtime Presence channels.

### Conversation model

Each conversation has a single row in the `conversations` table with `user_id` (the creator) and `other_user_id`. Both participants can read and write messages via RLS policies that check either column. Messages reference conversations through a `shared_id` UUID.

### Blocking

Blocking is two-way: the blocker cannot send messages to the blocked user, and the blocked user cannot send messages to the blocker. The check is enforced client-side before sending, and RLS policies prevent inserts from blocked users at the database level.
