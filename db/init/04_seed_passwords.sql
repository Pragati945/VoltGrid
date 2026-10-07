UPDATE users
SET password_hash = '$2b$10$4jxz2WdrcswR6WnC7gUC3eSWLlpqn965L5wxPvnRUAzHxI0WUPlly'
WHERE password_hash LIKE '$2b$10$placeholderhash%';
