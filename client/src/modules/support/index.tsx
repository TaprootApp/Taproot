import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import FormBuilder from "./FormBuilder";
import Forms from "./Forms";
import { MySubmissions, MyTickets } from "./MeSections";
import Submissions from "./Submissions";
import Tickets from "./Tickets";
import TicketSettings from "./TicketSettings";

// Support: tickets and forms.
export const module: ClientModule = {
  name: "support",
  pages: [
    { key: "forms", label: "Forms", icon: "clipboard", minLevel: StaffLevel.MEMBER, group: "You", component: Forms },
    { key: "tickets", label: "Tickets", icon: "ticket", minLevel: StaffLevel.MODERATOR, group: "Moderation", component: Tickets },
    { key: "submissions", label: "Submissions", icon: "fileText", minLevel: StaffLevel.MODERATOR, group: "Moderation", component: Submissions },
    { key: "ticketSettings", label: "Ticket settings", icon: "ticket", minLevel: StaffLevel.ADMIN, group: "Settings", component: TicketSettings },
    { key: "formBuilder", label: "Form builder", icon: "clipboard", minLevel: StaffLevel.ADMIN, group: "Settings", component: FormBuilder },
  ],
  meSections: [MyTickets, MySubmissions],
};
