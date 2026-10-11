-- The phone number behind a contact, so a LID (…@lid, which is not a phone number) can be traced
-- back to one — that is how the owners' messages are recognised in groups that address by LID.
ALTER TABLE contacts ADD COLUMN pn TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_pn ON contacts (pn);
