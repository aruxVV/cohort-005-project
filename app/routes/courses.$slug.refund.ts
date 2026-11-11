import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  courses,
  seats,
  lessons,
  modules,
  purchases,
  refundRequests,
  users,
  videoWatchEvents,
  RefundRequestStatus,
} from "~/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";

const REFUND_WINDOW_DAYS = 14;
const MAX_WATCHED_HOURS = 2;

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  const rows = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all();

  return rows.map((row) => row.id);
}

function getOpenRefundRequest(purchaseId: number) {
  return db
    .select()
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Open)
      )
    )
    .get();
}

// The fourteen-day window is counted in whole days, not hours — someone who
// buys at 23:00 should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

/**
 * The confirmation the Purchaser gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 *
 * Nothing has been refunded yet: this confirms an Open Refund Request, so it
 * says what approval would mean rather than promising money.
 */
function buildRefundRequestEmail(input: {
  purchaserName: string;
  purchaserEmail: string;
  courseTitle: string;
  amount: number;
  isTeamPurchase: boolean;
}) {
  const whatApprovalEnds = input.isTeamPurchase
    ? "and any unclaimed seats will stop working."
    : "and you'll lose access to the course straight away.";

  return {
    to: input.purchaserEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.purchaserName},`,
      "",
      `We have your refund request for "${input.courseTitle}". Our team reviews every request by hand, and we'll email you once we've decided.`,
      "",
      `If we approve it, we'll refund ${formatPrice(input.amount)}, the full amount you paid, ${whatApprovalEnds}`,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const purchaser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!purchaser) {
    throw data("User not found", { status: 404 });
  }

  const purchase = getLatestPurchase(currentUserId, course.id);

  if (!purchase) {
    throw data("You have not bought this course.", { status: 403 });
  }

  if (getOpenRefundRequest(purchase.id)) {
    throw data("You already have an open refund request on this purchase.", {
      status: 409,
    });
  }

  // A Team Purchase is refunded whole or not at all, so one Claimed Seat
  // blocks the Refund Request for the entire purchase.
  const claimedSeat = db
    .select({ id: seats.id })
    .from(seats)
    .where(
      and(eq(seats.purchaseId, purchase.id), isNotNull(seats.redeemedAt))
    )
    .get();

  if (claimedSeat) {
    throw data("A claimed team seat cannot be refunded.", { status: 403 });
  }

  const today = calendarDay(new Date());
  const withinRefundWindow = today <= lastDayOfWindow(purchase.createdAt);

  if (!withinRefundWindow) {
    throw data(`The ${REFUND_WINDOW_DAYS}-day window has closed.`, {
      status: 403,
    });
  }

  const courseLessonIds = getLessonIdsForCourse(course.id);

  let watchedSeconds = 0;
  if (courseLessonIds.length > 0) {
    const furthestPerLesson = db
      .select({
        furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
      })
      .from(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, currentUserId),
          inArray(videoWatchEvents.lessonId, courseLessonIds)
        )
      )
      .groupBy(videoWatchEvents.lessonId)
      .all();

    watchedSeconds = furthestPerLesson.reduce(
      (total, row) => total + row.furthest,
      0
    );
  }

  if (watchedSeconds >= MAX_WATCHED_HOURS * 60 * 60) {
    throw data("You have watched too much of this course to request a refund.", {
      status: 403,
    });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db
    .insert(refundRequests)
    .values({
      purchaseId: purchase.id,
      status: RefundRequestStatus.Open,
      reason: parsed.data.reason,
    })
    .returning()
    .get();

  // A Team Purchase is the only kind of Purchase that has Seats.
  const isTeamPurchase = !!db
    .select({ id: seats.id })
    .from(seats)
    .where(eq(seats.purchaseId, purchase.id))
    .get();

  const email = buildRefundRequestEmail({
    purchaserName: purchaser.name,
    purchaserEmail: purchaser.email,
    courseTitle: course.title,
    amount: purchase.amountPaid,
    isTeamPurchase,
  });

  console.log(
    `[email] to=${email.to} subject=${email.subject}\n${email.body}`
  );

  return redirect("/settings");
}
