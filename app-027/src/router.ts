import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
  { path: '/import', name: 'import', component: () => import('./views/ImportView.vue') },
  { path: '/import-report/:id', name: 'import-report', component: () => import('./views/ImportReportView.vue') },
  { path: '/design/:id', name: 'design', component: () => import('./views/DesignView.vue') },
  { path: '/layout/:id', name: 'layout', component: () => import('./views/LayoutView.vue') },
  { path: '/export/:id', name: 'export', component: () => import('./views/ExportView.vue') },
  { path: '/materials', name: 'materials', component: () => import('./views/MaterialsView.vue') },
  { path: '/help', name: 'help', component: () => import('./views/HelpView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})