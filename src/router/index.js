import { createRouter, createWebHistory } from 'vue-router'
import workspacePage from '@/views/workspace.vue'
import testPage from '@/views/test.vue'
import authPage from '@/views/Auth.vue'

const routes = [
  { path: '/', name: 'workspacePage', component: workspacePage },
  { path: '/register', name: 'authPage', component: authPage },
  { path: '/abc', name: 'testPage', component: testPage }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
