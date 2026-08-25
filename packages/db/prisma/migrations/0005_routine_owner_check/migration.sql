ALTER TABLE "routines"
ADD CONSTRAINT "routines_exactly_one_owner_check"
CHECK (num_nonnulls("botId", "groupId") = 1);
