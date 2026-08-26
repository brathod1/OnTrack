import { redirect } from "next/navigation";

/**
 * The root path goes straight to My Work.
 *
 * There is no dashboard or landing page, deliberately. This is an internal
 * tool people open twenty times a day; a splash screen between them and their
 * task list is twenty wasted clicks. If they are not signed in, middleware
 * redirects to /signin before this runs.
 */
export default function RootPage() {
  redirect("/tasks");
}
