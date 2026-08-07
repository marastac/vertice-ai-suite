import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { queryClient } from '@/app/providers/query-client'
import { AuthProvider } from '@/entities/auth'
import { OrganizationProvider } from '@/entities/organization'
import { router } from '@/app/router'

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OrganizationProvider>
          <RouterProvider router={router} />
        </OrganizationProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}

export default App
