if (!window.Eurus.loadedScript.has('tooltips-position.js')) {
  window.Eurus.loadedScript.add('tooltips-position.js');
  requestAnimationFrame(() => {
    document.addEventListener('alpine:init', () => {
      Alpine.data('xTooltips', (configs) => ({
        sectionId: configs.sectionId,
        blockId: configs.blockId,
        hotspotHorizontal: configs.hotspotHorizontal,
        hotspotVertical: configs.hotspotVertical,

        updatePositionTooltips() {
          const banner = this.$refs.tooltips.closest('.shop-the-look-image');
          const tooltips = this.$refs.tooltips;
          const arrowBottom = tooltips.querySelector(`.arrow-bottom-${this.blockId}`);
          const arrowTop = tooltips.querySelector(`.arrow-top-${this.blockId}`);

          if (this.hotspotVertical >= 50) {
            const overflow = tooltips.getBoundingClientRect().height + 16 - ( banner.getBoundingClientRect().height - 64 ) * this.hotspotVertical / 100;   
            if (overflow < 0) {
              arrowBottom.parentElement.classList.remove('hidden');   
              arrowBottom.style.margin = `0 0 0 calc(${this.hotspotHorizontal}% - 1rem)`;
            } else {
              tooltips.querySelector(`.layered-shadow-${this.sectionId}`)?.classList.remove('rounded-br-none', 'rounded-bl-none');
              tooltips.classList.replace('md:block', 'md:flex');
              if (this.hotspotHorizontal >= 50) {
                tooltips.style.left = '0';
                tooltips.style.top = '100%';
                tooltips.style.transform = `translateY(-${this.hotspotVertical}%) translateX(-100%)`;
                this._changeArrowDirection(arrowBottom, 'right');           
                arrowBottom.style.margin = `${this.hotspotVertical / 100 * tooltips.getBoundingClientRect().height - 48}px 0 0 0`;
              } else {
                tooltips.style.left = '100%';
                tooltips.style.top = '100%';
                tooltips.style.transform = `translateY(-${this.hotspotVertical}%)`;
                this._changeArrowDirection(arrowTop, 'left');
                arrowTop.style.margin = `${this.hotspotVertical / 100 * tooltips.getBoundingClientRect().height - 48}px 0 0 0`;
              }                    
            }
          } else {
            const overflow = tooltips.getBoundingClientRect().height + 16 - (1 - this.hotspotVertical / 100) * (banner.getBoundingClientRect().height - 64);
            if (overflow < 0) {
              arrowTop.parentElement.classList.remove('hidden'); 
              arrowTop.style.margin = `0 0 0 calc(${this.hotspotHorizontal}% - 1rem)`;                   
            } else {
              tooltips.querySelector(`.layered-shadow-${this.sectionId}`)?.classList.remove('rounded-tr-none', 'rounded-tl-none');
              tooltips.classList.replace('md:block', 'md:flex');
              if (this.hotspotHorizontal >= 50) {                   
                tooltips.style.left = '0';
                tooltips.style.top = '0';
                tooltips.style.transform = `translateY(-${this.hotspotVertical}%) translateX(-100%)`;
                this._changeArrowDirection(arrowBottom, 'right');
                arrowBottom.style.margin = `${this.hotspotVertical / 100 * tooltips.getBoundingClientRect().height + 16}px 0 0 0`;
              } else {
                tooltips.style.left = '100%';
                tooltips.style.top = '0';
                tooltips.style.transform = `translateY(-${this.hotspotVertical}%)`;
                this._changeArrowDirection(arrowTop, 'left');
                arrowTop.style.margin = `${this.hotspotVertical / 100 * tooltips.getBoundingClientRect().height + 16}px 0 0 0`;
              }                      
            }
          }
        },
        _changeArrowDirection(arrow, type) {
          arrow.parentElement.classList.remove('hidden');
          if (type === "right") {
            arrow.parentElement.classList.replace('-mt-px', '-ml-px');
            arrow.classList.remove('border-x-[1rem]', 'border-x-transparent', 'border-t-[rgba(var(--background-color),1)]', 'border-t-[1rem]');
            arrow.classList.add('border-y-[1rem]', 'border-y-transparent', 'border-l-[rgba(var(--background-color),1)]', 'border-l-[1rem]');            
          } else {
            arrow.parentElement.classList.replace('-mb-px', '-mr-px');
            arrow.classList.remove('border-x-[1rem]', 'border-x-transparent', 'border-b-[rgba(var(--background-color),1)]', 'border-b-[1rem]');
            arrow.classList.add('border-y-[1rem]', 'border-y-transparent', 'border-r-[rgba(var(--background-color),1)]', 'border-r-[1rem]');            
          }
        }
      }))
    })
  })
}