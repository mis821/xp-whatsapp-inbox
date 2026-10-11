-- The dashboard is now in English: the "own work" owner is "Self", not "Khud".
UPDATE tasks SET team = 'Self' WHERE team = 'Khud' OR team IS NULL;
