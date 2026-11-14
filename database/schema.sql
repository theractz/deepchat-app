-- ==========================================
-- 1. TABEL PROFIL USER
-- ==========================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE, 
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- ==========================================
-- 2. TABEL KREDIT USER
-- ==========================================
CREATE TABLE IF NOT EXISTS user_credits (
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE PRIMARY KEY,
  deepseek_limit INTEGER DEFAULT 5,  
  gpt_limit INTEGER DEFAULT 0,
  glm_limit INTEGER DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- ==========================================
-- 3. TABEL KODE REDEEM (VOUCHER)
-- ==========================================
CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,
  deepseek_amount INTEGER DEFAULT 0,
  gpt_amount INTEGER DEFAULT 0,
  glm_amount INTEGER DEFAULT 0,
  is_used BOOLEAN DEFAULT FALSE,
  used_by UUID REFERENCES profiles(id),
  used_at TIMESTAMP WITH TIME ZONE
);

-- ==========================================
-- 4. TABEL LOG TAMU
-- ==========================================
CREATE TABLE IF NOT EXISTS guest_logs (
  id BIGSERIAL PRIMARY KEY,
  ip_address TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- ==========================================
-- 5. TRIGGER OTOMATIS BUAT USER BARU
-- ==========================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email) 
  VALUES (new.id, new.email)
  ON CONFLICT (id) DO NOTHING; -- Biar aman kalau data udah ada
  
  INSERT INTO public.user_credits (user_id) 
  VALUES (new.id)
  ON CONFLICT (user_id) DO NOTHING;
  
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ==========================================
-- 6. ROW LEVEL SECURITY (RLS) & POLICIES
-- ==========================================
-- Aktifkan RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;

-- Hapus policy lama (biar nggak error "already exists" pas di-run ulang)
DROP POLICY IF EXISTS "User can view own profile" ON profiles;
DROP POLICY IF EXISTS "User can view own credits" ON user_credits;
DROP POLICY IF EXISTS "Allow insert profiles" ON profiles;
DROP POLICY IF EXISTS "Allow insert user_credits" ON user_credits;

-- Bikin policy baru
CREATE POLICY "User can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "User can view own credits" ON user_credits FOR SELECT USING (auth.uid() = user_id);

-- PENTING: Izinkan Trigger buat masukin data (karena RLS nyala)
CREATE POLICY "Allow insert profiles" ON profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow insert user_credits" ON user_credits FOR INSERT WITH CHECK (true);