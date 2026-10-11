import "vue-router";

declare module "vue-router" {
  interface RouteMeta {
    /** Render the page full-screen, without the panel sidebar (first-run window). */
    bare?: boolean;
  }
}
