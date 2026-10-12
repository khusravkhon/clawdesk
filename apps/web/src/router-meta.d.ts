import "vue-router";

declare module "vue-router" {
  interface RouteMeta {
    /** Render the page full-screen, without the panel sidebar (first-run window). */
    bare?: boolean;
    /** Open without signing in (sign-in and owner password screens). */
    public?: boolean;
  }
}
