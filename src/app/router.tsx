import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import { ProtectedRoute } from './layout/ProtectedRoute'
import { LoginPage } from '@/features/auth/LoginPage'
import { RegisterPage } from '@/features/auth/RegisterPage'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { LeadsPage } from '@/features/leads/LeadsPage'
import { LeadDetailPage } from '@/features/leads/LeadDetailPage'
import { FormsPage } from '@/features/forms/FormsPage'
import { FormBuilderPage } from '@/features/forms/FormBuilderPage'
import { FormSubmissionsPage } from '@/features/forms/FormSubmissionsPage'
import { PublicFormPage } from '@/features/public-form/PublicFormPage'
import { PublicChatPage } from '@/features/public-chat/PublicChatPage'
import { ChatSettingsPage } from '@/features/chat-settings/ChatSettingsPage'
import { ConversationsPage } from '@/features/conversations/ConversationsPage'
import { IntegrationsPage } from '@/features/integrations/IntegrationsPage'
import { TeamPage } from '@/features/team/TeamPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { NotFoundPage } from '@/features/not-found/NotFoundPage'

export const router = createBrowserRouter([
  {
    path: '/f/:formId',
    element: <PublicFormPage />,
  },
  {
    path: '/c/:orgSlug',
    element: <PublicChatPage />,
  },
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/register',
    element: <RegisterPage />,
  },
  {
    path: '/forgot-password',
    element: <ForgotPasswordPage />,
  },
  {
    path: '/reset-password',
    element: <ResetPasswordPage />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'leads', element: <LeadsPage /> },
      { path: 'leads/:leadId', element: <LeadDetailPage /> },
      { path: 'forms', element: <FormsPage /> },
      { path: 'forms/new', element: <FormBuilderPage /> },
      { path: 'forms/:formId/edit', element: <FormBuilderPage /> },
      { path: 'forms/:formId/submissions', element: <FormSubmissionsPage /> },
      { path: 'conversations', element: <ConversationsPage /> },
      { path: 'chat-settings', element: <ChatSettingsPage /> },
      { path: 'integrations', element: <IntegrationsPage /> },
      { path: 'team', element: <TeamPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
