import type {
  AcceptCredentialActivationInput,
  AccountDirectoryQuery,
  AddWorkspaceMemberInput,
  CreateManagedAccountInput,
  CreatePlatformGrantInput,
  CreateWorkspaceGrantInput,
  CreateWorkspaceInput,
  IdentityAuditQuery,
  IssueCredentialActivationInput,
  PlatformGrantQuery,
  RevokeGrantInput,
  UpdateGrantExpiryInput,
  UpdateManagedAccountInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberStatusInput,
  WorkspaceListQuery,
} from "@pluginmax/contracts";
import type { IdentityAdministrationRepository } from "@pluginmax/database";

export interface IdentityAdministrationPrincipal {
  readonly principalId: string;
  readonly platformAdministrator: boolean;
}

export class IdentityAdministrationService {
  constructor(private readonly repository: IdentityAdministrationRepository) {}

  listAccounts(input: AccountDirectoryQuery) {
    return this.repository.listAccounts(input);
  }

  getAccount(accountId: string) {
    return this.repository.getAccount(accountId);
  }

  listIdentityAudit(input: IdentityAuditQuery) {
    return this.repository.listIdentityAudit(input);
  }

  listPlatformRoles() {
    return this.repository.listPlatformRoles();
  }

  listPlatformGrants(input: PlatformGrantQuery) {
    return this.repository.listPlatformGrants(input);
  }

  createAccount(actorPrincipalId: string, input: CreateManagedAccountInput) {
    return this.repository.createAccount(actorPrincipalId, input);
  }

  updateAccount(
    actorPrincipalId: string,
    accountId: string,
    input: UpdateManagedAccountInput,
  ) {
    return this.repository.updateAccount(actorPrincipalId, accountId, input);
  }

  issueCredentialActivation(
    actorPrincipalId: string,
    accountId: string,
    input: IssueCredentialActivationInput,
  ) {
    return this.repository.issueCredentialActivation(
      actorPrincipalId,
      accountId,
      input,
    );
  }

  acceptCredentialActivation(input: AcceptCredentialActivationInput) {
    return this.repository.acceptCredentialActivation(input);
  }

  createPlatformGrant(
    actorPrincipalId: string,
    input: CreatePlatformGrantInput,
  ) {
    return this.repository.createPlatformGrant(actorPrincipalId, input);
  }

  updatePlatformGrantExpiry(
    actorPrincipalId: string,
    grantId: string,
    input: UpdateGrantExpiryInput,
  ) {
    return this.repository.updatePlatformGrantExpiry(
      actorPrincipalId,
      grantId,
      input,
    );
  }

  revokePlatformGrant(
    actorPrincipalId: string,
    grantId: string,
    input: RevokeGrantInput,
  ) {
    return this.repository.revokePlatformGrant(
      actorPrincipalId,
      grantId,
      input,
    );
  }

  listWorkspaces(
    principal: IdentityAdministrationPrincipal,
    query: WorkspaceListQuery,
  ) {
    return this.repository.listWorkspaces({
      principalId: principal.principalId,
      platformAdministrator: principal.platformAdministrator,
      query,
    });
  }

  getWorkspace(workspaceId: string) {
    return this.repository.getWorkspace(workspaceId);
  }

  createWorkspace(actorPrincipalId: string, input: CreateWorkspaceInput) {
    return this.repository.createWorkspace(actorPrincipalId, input);
  }

  updateWorkspace(
    actorPrincipalId: string,
    workspaceId: string,
    input: UpdateWorkspaceInput,
  ) {
    return this.repository.updateWorkspace(
      actorPrincipalId,
      workspaceId,
      input,
    );
  }

  addWorkspaceMember(
    actorPrincipalId: string,
    workspaceId: string,
    input: AddWorkspaceMemberInput,
  ) {
    return this.repository.addWorkspaceMember(
      actorPrincipalId,
      workspaceId,
      input,
    );
  }

  updateWorkspaceMemberStatus(
    actorPrincipalId: string,
    workspaceId: string,
    memberId: string,
    input: UpdateWorkspaceMemberStatusInput,
  ) {
    return this.repository.updateWorkspaceMemberStatus(
      actorPrincipalId,
      workspaceId,
      memberId,
      input,
    );
  }

  createWorkspaceGrant(
    actorPrincipalId: string,
    workspaceId: string,
    input: CreateWorkspaceGrantInput,
  ) {
    return this.repository.createWorkspaceGrant(
      actorPrincipalId,
      workspaceId,
      input,
    );
  }

  updateWorkspaceGrantExpiry(
    actorPrincipalId: string,
    workspaceId: string,
    grantId: string,
    input: UpdateGrantExpiryInput,
  ) {
    return this.repository.updateWorkspaceGrantExpiry(
      actorPrincipalId,
      workspaceId,
      grantId,
      input,
    );
  }

  revokeWorkspaceGrant(
    actorPrincipalId: string,
    workspaceId: string,
    grantId: string,
    input: RevokeGrantInput,
  ) {
    return this.repository.revokeWorkspaceGrant(
      actorPrincipalId,
      workspaceId,
      grantId,
      input,
    );
  }
}
