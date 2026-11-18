// Imported before the router (main.ts): what a link of the karyl-chan bot left in the address's
// fragment comes out of it before the router's history reads the address and keeps it
// (docs/spec/karyl-login.md, sections 1 and 7).
import { takeLinkResult } from "./served";

takeLinkResult();
