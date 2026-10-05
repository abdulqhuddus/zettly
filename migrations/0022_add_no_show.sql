ALTER TABLE bookings ADD COLUMN no_show INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN pre_cancellation_commute_fee INTEGER;
