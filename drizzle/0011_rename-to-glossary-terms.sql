-- Rename tables to the glossary's terms: a refunds row is a Refund Request,
-- and a coupons row is a Seat. Learners were stored with the role 'student'.
ALTER TABLE `refunds` RENAME TO `refund_requests`;--> statement-breakpoint
DROP INDEX `refunds_purchase_idx`;--> statement-breakpoint
CREATE INDEX `refund_requests_purchase_idx` ON `refund_requests` (`purchase_id`);--> statement-breakpoint
ALTER TABLE `coupons` RENAME TO `seats`;--> statement-breakpoint
DROP INDEX `coupons_code_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `seats_code_unique` ON `seats` (`code`);--> statement-breakpoint
UPDATE `users` SET `role` = 'learner' WHERE `role` = 'student';
