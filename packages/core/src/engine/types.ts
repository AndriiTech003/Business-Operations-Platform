import type { CoreDeps } from '../deps';
import type { NotificationsService } from '../services/activity';
import type { ApprovalsService } from '../services/approvals';
import type { CompaniesService } from '../services/companies';
import type { ContactsService } from '../services/contacts';
import type { CustomFieldsService } from '../services/custom-fields';
import type { DealsService } from '../services/deals';
import type { Directory } from '../services/directory';
import type { EmailsService } from '../services/emails';
import type { InvoicesService } from '../services/invoices';
import type { SecretsService } from '../services/accounts';
import type { TasksService } from '../services/tasks';
import type { AiProvider } from './ai';
import type { WorkflowsService } from './definitions';
import type { Effects } from './effects';
import type { RecordLoader } from './records';

export interface EngineServices {
  deps: CoreDeps;
  directory: Directory;
  tasks: TasksService;
  deals: DealsService;
  companies: CompaniesService;
  contacts: ContactsService;
  invoices: InvoicesService;
  emails: EmailsService;
  notifications: NotificationsService;
  approvals: ApprovalsService;
  records: RecordLoader;
  customFields: CustomFieldsService;
  secrets: SecretsService;
  workflows: WorkflowsService;
  effects: Effects;
  ai: AiProvider;
}
